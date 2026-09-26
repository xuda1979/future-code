"""Trusted local certificate kernel; no semantic claim is inferred from prose.

Hashes bind records, not truth. Only a trusted checker may submit Evidence. These
objects are not signatures or a hostile-worker proof system. Each gate must declare
its complete read set, including checker/config/environment dependencies.
"""
from __future__ import annotations
from dataclasses import dataclass, asdict
import hashlib
import json
import threading
from typing import Mapping, Sequence
from .tree import CostModel, Node, validate_tree


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('ascii')


def digest(value: object) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


@dataclass(frozen=True)
class Gate:
    id: str
    dependencies: tuple[str, ...]
    checker: str = 'trusted-checker-v1'


@dataclass(frozen=True)
class Evidence:
    binding: str
    status: str
    trace_hash: str


@dataclass(frozen=True)
class Capsule:
    lo: int
    hi: int
    counts: tuple[int, int, int]  # PASS, FAIL, UNKNOWN
    binding: str
    evidence: str
    registry: str

    @property
    def verdict(self) -> str:
        return 'FAIL' if self.counts[1] else ('UNKNOWN' if self.counts[2] else 'PASS')

    def as_dict(self) -> dict:
        return {'range': [self.lo, self.hi], 'counts': list(self.counts),
                'binding': self.binding, 'evidence': self.evidence, 'registry': self.registry}

    def to_bytes(self, width: int = 320) -> bytes:
        raw = canonical(self.as_dict())
        if len(raw) > width:
            raise ValueError('mandatory certificate exceeds card budget; do not truncate')
        return raw.ljust(width, b' ')


@dataclass(frozen=True)
class Ticket:
    revision: int
    registry: str
    root: Capsule


class Kernel:
    """Single-process transactional reference implementation.

    The RLock makes local snapshot/commit checks atomic. It is NOT distributed
    consensus, does not lock arbitrary external files, and is not an OS sandbox.
    The caller checks immutable file snapshots and records dependency hashes.
    """
    def __init__(self, gates: Sequence[Gate], artifacts: Mapping[str, str],
                 model: CostModel = CostModel()):
        self.gates = tuple(gates)
        if not gates or len({g.id for g in gates}) != len(gates):
            raise ValueError('nonempty unique gate registry required')
        if any(not g.dependencies or len(set(g.dependencies)) != len(g.dependencies) for g in gates):
            raise ValueError('gate dependencies must be nonempty and unique')
        if any(dep not in artifacts for g in gates for dep in g.dependencies):
            raise ValueError('unresolved dependency')
        self.registry = digest([asdict(g) for g in gates])
        self.artifacts = dict(artifacts)
        self.model = model
        self.revision = 0
        self.records: dict[int, Evidence] = {}
        self._cache: dict[tuple[str, int, int], tuple[int, Capsule]] = {}
        self._generation = 1
        self._gate_generation = [1] * len(gates)
        self._root: Capsule | None = None
        self._lock = threading.RLock()
        self._dirty = set(range(len(gates)))

    def gate_binding(self, i: int) -> str:
        gate = self.gates[i]
        return digest({'registry': self.registry, 'gate': gate.id,
                       'checker': gate.checker,
                       'inputs': [(d, self.artifacts[d]) for d in gate.dependencies]})

    def update_artifacts(self, changes: Mapping[str, str]) -> set[int]:
        with self._lock:
            if any(d not in self.artifacts for d in changes):
                raise ValueError('unknown artifact; revise the registry explicitly')
            changed = {d for d, value in changes.items() if self.artifacts[d] != value}
            if not changed:
                return set()
            self.artifacts.update(changes)
            self.revision += 1
            affected = {i for i, g in enumerate(self.gates) if changed.intersection(g.dependencies)}
            self._dirty.update(affected)
            self._generation += 1
            for i in affected:
                self._gate_generation[i] = self._generation
                self.records.pop(i, None)
            self._root = None  # immediate publication revocation
            return affected

    def submit_trusted(self, i: int, evidence: Evidence) -> None:
        """Internal verifier API, not a tool that arbitrary LLM agents may call."""
        with self._lock:
            if type(i) is not int or not 0 <= i < len(self.gates):
                raise ValueError('invalid gate index')
            if evidence.binding != self.gate_binding(i):
                raise ValueError('stale checker evidence')
            if evidence.status not in {'PASS', 'FAIL', 'UNKNOWN'}:
                raise ValueError('invalid verifier status')
            if len(evidence.trace_hash) != 64 or any(c not in '0123456789abcdef' for c in evidence.trace_hash):
                raise ValueError('invalid evidence hash')
            self.records[i] = evidence
            self._generation += 1
            self._gate_generation[i] = self._generation
            self._dirty.add(i)
            self._root = None

    def _leaf(self, i: int) -> Capsule:
        key = self.gate_binding(i)
        record = self.records.get(i)
        status = record.status if record is not None and record.binding == key else 'UNKNOWN'
        count = tuple(int(status == value) for value in ('PASS', 'FAIL', 'UNKNOWN'))
        commitment = digest({'gate': self.gates[i].id, 'binding': key, 'status': status,
                             'trace': record.trace_hash if record and record.binding == key else None})
        return Capsule(i, i, count, key, commitment, self.registry)

    def _merge(self, node: Node, children: list[Capsule]) -> Capsule:
        cursor = node.lo
        for child in children:
            if child.lo != cursor or child.registry != self.registry:
                raise ValueError('noncontiguous, overlapping or foreign certificate')
            if any(type(c) is not int or c < 0 for c in child.counts) or sum(child.counts) != child.hi - child.lo + 1:
                raise ValueError('invalid certificate coverage')
            cursor = child.hi + 1
        if cursor != node.hi + 1:
            raise ValueError('incomplete interval coverage')
        counts = tuple(sum(c.counts[j] for c in children) for j in range(3))
        return Capsule(node.lo, node.hi, counts,
                       digest([c.binding for c in children]),
                       digest([c.as_dict() for c in children]), self.registry)

    def packet(self, node: Node, children: list[Capsule]) -> bytes:
        """A fixed-width JSON-lines control packet; bytes are not token counts."""
        self.model.packet_bytes(len(children))
        header = canonical({'schema': 'hact-1', 'range': [node.lo, node.hi],
                            'registry': self.registry,
                            'instruction': 'Use trusted capsule counts only for this declared contract. '
                            'Never convert UNKNOWN into PASS. Evidence hashes reference durable records. '
                            'Natural-language conclusions require separate checks.'})
        if len(header) > self.model.header:
            raise ValueError('mandatory header does not fit')
        packet = header.ljust(self.model.header - 1, b' ') + b'\n'
        for child in children:
            packet += child.to_bytes(self.model.card - 1) + b'\n'
        if len(packet) > self.model.cap:
            raise ValueError('context budget exceeded')
        return packet

    def refresh(self, tree: Node, *, force: bool = False) -> tuple[Capsule, list[bytes]]:
        with self._lock:
            validate_tree(tree, len(self.gates), self.model)
            tree_id = digest(tree.to_dict())
            packets: list[bytes] = []
            def visit(node: Node) -> Capsule:
                cache_key = (tree_id, node.lo, node.hi)
                stamp = max(self._gate_generation[node.lo:node.hi + 1])
                cached = self._cache.get(cache_key)
                if not force and cached is not None and cached[0] == stamp:
                    return cached[1]
                if node.leaf:
                    result = self._leaf(node.lo)
                else:
                    children = [visit(c) for c in node.children]
                    result = self._merge(node, children)
                    packets.append(self.packet(node, children))
                self._cache[cache_key] = (stamp, result)
                return result
            self._root = visit(tree)
            self._dirty.clear()
            return self._root, packets

    def ticket(self) -> Ticket:
        with self._lock:
            if self._root is None or self._dirty:
                raise ValueError('root certificate is unavailable or dirty')
            return Ticket(self.revision, self.registry, self._root)

    def publish(self, ticket: Ticket) -> bool:
        """Atomic local decision; it does not deploy an external artifact."""
        with self._lock:
            return bool(not self._dirty and self._root is not None
                        and ticket.revision == self.revision and ticket.registry == self.registry
                        and ticket.root == self._root and ticket.root.verdict == 'PASS'
                        and ticket.root.counts == (len(self.gates), 0, 0)
                        and (ticket.root.lo, ticket.root.hi) == (0, len(self.gates) - 1))

    def check_external_capsule(self, supplied: bytes, canonical_capsule: Capsule) -> bool:
        """Check a returned display against the trusted record, not its own hash."""
        try:
            return json.loads(supplied) == canonical_capsule.as_dict()
        except (ValueError, TypeError, UnicodeError):
            return False
