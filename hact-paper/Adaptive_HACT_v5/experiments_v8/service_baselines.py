"""V9 correction: independent queries over maintained tree and ledger state.

Only framing, predicates and schema are shared with the reference oracle.
Timings are local host measurements; logical storage/update bytes are not
network traffic. Results/v8 remains the unmodified historical study.
"""
from __future__ import annotations

import json
import time
import zlib
from dataclasses import dataclass, field

from experiments_v8 import service_core as core
from hact.certificates import CostModel, Evidence, Gate, Kernel, canonical, digest
from ichact.layout import Layout


@dataclass
class ServiceCosts:
    index_build_bytes: int = 0
    index_maintenance_bytes: int = 0
    storage_bytes: int = 0  # current canonical serialized state, not resident RAM
    aggregation_bytes_scanned: int = 0
    aggregation_cpu_calls: int = 0
    cache_hits: int = 0
    cache_misses: int = 0
    encode_bytes: int = 0
    decode_bytes: int = 0
    pages: int = 0
    round_trips: int = 0  # logical messages; no transport RTT claim
    failure_disclosures: int = 0
    index_build_seconds: float = 0.0
    index_maintenance_seconds: float = 0.0
    aggregation_seconds: float = 0.0
    encode_seconds: float = 0.0
    decode_seconds: float = 0.0

    def as_dict(self):
        return dict(self.__dict__)


def _now():
    return time.perf_counter()


class _QueryService:
    """Common admission/framing; record access and status aggregation differ."""
    def _total_waves(self):
        return (len(self.trajectory.evidence['executed']) + core.DEFAULT_WAVE_SIZE - 1) // core.DEFAULT_WAVE_SIZE

    def _cached(self, key, produce):
        if key in self._cache:
            self.costs.cache_hits += 1
            return json.loads(json.dumps(self._cache[key]))
        self.costs.cache_misses += 1
        result = produce()
        if len(self._cache) >= self.cache_max_entries:
            self._cache.pop(next(iter(self._cache)))  # declared FIFO
        self._cache[key] = json.loads(json.dumps(result))
        return result

    def _sync(self, snapshot):
        if (snapshot.trajectory.identity != self.trajectory.identity
                or snapshot.registry != self.trajectory.registry):
            raise ValueError('foreign candidate snapshot')
        expected = tuple(self.trajectory.evidence['executed'][:snapshot.epoch * core.DEFAULT_WAVE_SIZE])
        if snapshot.executed != expected:
            raise ValueError('foreign completion prefix in snapshot')
        if snapshot.epoch < self._epoch:
            self._build()  # old snapshots are rebuilt, never mixed with new state
            self._epoch = -1
        if snapshot.epoch != self._epoch:
            self._cache.clear()
            self._ingest(snapshot)
            self._epoch = snapshot.epoch

    def _select(self, selection):
        registry = self.trajectory.registry
        if isinstance(selection, str):
            if selection == 'all':
                return list(registry)
            if selection in ('failing', 'unfinished'):
                return [cid for cid in registry if
                        (self.record_of(cid) is None if selection == 'unfinished'
                         else self._status_of(cid) == 'FAIL')]
            if selection in ('unit', 'integration'):
                predicate = core.predicate_unit if selection == 'unit' else core.predicate_integration
                return [cid for cid in registry if predicate(cid)]
            if selection in registry:
                return [selection]
            raise ValueError('unknown semantic set or member: %r' % selection)
        selected = list(selection)
        if any(cid not in registry for cid in selected):
            raise ValueError('unknown semantic member')
        if len(set(selected)) != len(selected):
            raise ValueError('duplicate semantic members in S')
        return selected

    def _status_of(self, cid):
        record = self.record_of(cid)
        return record['status'] if record is not None else 'UNKNOWN'

    def _answer(self, selected, mode, wave):
        """Schema construction over this service's records, never raw snapshots."""
        if mode == 'status':
            counts = self._counts(selected)
            return {'required': len(selected), 'counts': counts,
                    'verdict': 'FAIL' if counts['FAIL'] else 'UNKNOWN' if counts['UNKNOWN'] else 'PASS',
                    'unfinished': [cid for cid in selected if self.record_of(cid) is None]}
        if mode == 'failure_localization':
            failing, groups = [], {}
            for cid in selected:
                rec = self.record_of(cid)
                if rec is None or rec['status'] != 'FAIL':
                    continue
                phases = {name: {'outcome': phase.get('outcome')}
                          for name, phase in (rec.get('phases') or {}).items() if phase}
                failing.append({'id': cid, 'phase_outcomes': phases,
                                'context': rec.get('failure') or '',
                                'wall_seconds': rec.get('wall_seconds')})
                groups.setdefault(cid.split('::', 1)[0], []).append(cid)
            return {'failing_count': len(failing), 'failing': failing,
                    'groups': {key: sorted(value) for key, value in sorted(groups.items())}}
        if mode == 'coverage_proof':
            executed = [cid for cid in selected if self.record_of(cid) is not None]
            missing = [cid for cid in selected if self.record_of(cid) is None]
            counts = self._counts(selected)
            passed = counts['PASS'] == len(selected)
            return {'declared': len(selected), 'declared_ids': list(selected),
                    'executed': len(executed), 'executed_ids': executed, 'missing': missing,
                    'all_declared_passed': passed,
                    'eligible_authorization': bool(self.trajectory.report.get('locally_authorized')) and passed,
                    'scope': 'All declared checks passed for the declared contract; this is '
                             'not a claim that the check set suffices for arbitrary '
                             'program correctness.'}
        if mode == 'replay':
            if type(wave) is not int or wave < 0 or wave >= self._total_waves():
                raise ValueError('unknown wave %r for replay' % wave)
            if wave >= self._epoch:
                self.costs.failure_disclosures += 1
                return {'refused': True, 'reason': 'wave beyond stated epoch',
                        'wave': wave, 'epoch': self._epoch}
            members = self._executed[wave * core.DEFAULT_WAVE_SIZE:(wave + 1) * core.DEFAULT_WAVE_SIZE]
            return {'refused': False, 'wave': wave, 'members': list(members),
                    'counts': self._counts(members),
                    'wall_seconds_total': sum(self.record_of(cid).get('wall_seconds', 0.0) for cid in members)}
        raise ValueError('unknown mode %r' % mode)

    def query(self, query_id, snapshot, s, mode, *, wave=None):
        self._sync(snapshot)
        if mode == 'replay' and wave is None:
            raise ValueError('replay mode requires an explicit wave')
        started = _now()
        key = (query_id, self._epoch, canonical(s), mode, wave)
        semantic = self._cached(key, lambda: self._answer(self._select(s), mode, wave))
        self.costs.aggregation_seconds += _now() - started
        started = _now()
        pages = core.pack_answers(semantic, self.trajectory.identity, query_id,
                                  self._epoch, self._total_waves(), budget=self.budget)
        wire = zlib.compress(b''.join(pages), 6)
        compressed = {'raw_bytes': sum(map(len, pages)), 'answer_zlib_bytes': len(wire)}
        self.costs.encode_seconds += _now() - started
        self.costs.encode_bytes += compressed['answer_zlib_bytes']
        self.costs.pages += len(pages)
        self.costs.round_trips += len(pages)
        # The consumer verifies an actual codec round trip and complete pages.
        started = _now()
        decoded = zlib.decompress(wire)
        if decoded != b''.join(pages) or core.unpack_answers(pages, self.budget) != semantic:
            raise ValueError('answer codec/reconstruction mismatch')
        self.costs.decode_seconds += _now() - started
        self.costs.decode_bytes += len(decoded)
        return core.Answer(query_id, mode, dict(self.trajectory.identity), self._epoch,
                           self._total_waves(), semantic, total_pages=len(pages),
                           extras={'compressed': compressed, **self._extras()})

    def _extras(self):
        return {}


@dataclass
class IndexedFlatLedger(_QueryService):
    trajectory: core.Trajectory
    budget: int = core.DEFAULT_BUDGET
    cache_max_entries: int = 128
    costs: ServiceCosts = field(default_factory=ServiceCosts, init=False)
    _index: dict = field(default_factory=dict, init=False, repr=False)
    _ledger: list = field(default_factory=list, init=False, repr=False)
    _cache: dict = field(default_factory=dict, init=False, repr=False)
    _epoch: int = field(default=-1, init=False)

    def __post_init__(self):
        self._build()

    def _build(self):
        started = _now()
        self._index = {cid: None for cid in self.trajectory.registry}
        self._ledger = []
        self._executed = []
        self._cache.clear()
        self.costs.index_build_bytes += len(canonical(self._index))
        self.costs.storage_bytes = len(canonical({'index': self._index, 'ledger': self._ledger}))
        self.costs.index_build_seconds += _now() - started

    def _ingest(self, snapshot):
        started = _now()
        for cid in snapshot.executed[len(self._ledger):]:
            rec = json.loads(json.dumps(snapshot.records[cid]))
            event = {'id': cid, **rec, 'wave': len(self._ledger) // core.DEFAULT_WAVE_SIZE}
            self._index[cid] = len(self._ledger)
            self._ledger.append(event)
            self._executed.append(cid)
            self.costs.index_maintenance_bytes += len(canonical(event))
        self.costs.storage_bytes = len(canonical({'index': self._index, 'ledger': self._ledger}))
        self.costs.index_maintenance_seconds += _now() - started

    def record_of(self, check_id):
        if check_id not in self._index:
            raise ValueError('missing semantic index entry')
        position = self._index[check_id]
        if position is None:
            return None
        if not 0 <= position < len(self._ledger) or self._ledger[position]['id'] != check_id:
            raise ValueError('corrupt ledger index')
        row = self._ledger[position]
        self.costs.aggregation_bytes_scanned += len(canonical(row))
        self.costs.aggregation_cpu_calls += 1
        return row

    def _counts(self, selected):
        counts = dict.fromkeys(core.STATUS_ORDER, 0)
        for cid in selected:
            counts[self._status_of(cid)] += 1
        return counts

    def whole_ledger_zlib_bytes(self):
        return len(zlib.compress(canonical(self._ledger), 6))


@dataclass
class HactService(_QueryService):
    trajectory: core.Trajectory
    layout: Layout
    budget: int = core.DEFAULT_BUDGET
    cache_max_entries: int = 128
    costs: ServiceCosts = field(default_factory=ServiceCosts, init=False)
    _kernel: Kernel = field(default=None, init=False, repr=False)
    _cache: dict = field(default_factory=dict, init=False, repr=False)
    _epoch: int = field(default=-1, init=False)

    def __post_init__(self):
        if tuple(self.layout.registry) != self.trajectory.registry:
            raise ValueError('layout registry must match the trajectory registry')
        self._build()

    def _build(self):
        started = _now()
        ordered = [self.trajectory.registry[i] for i in self.layout.order]
        self._positions = {cid: i for i, cid in enumerate(ordered)}
        self._kernel = Kernel([Gate(cid, ('identity',)) for cid in ordered],
                              {'identity': digest(self.trajectory.identity)}, self.layout.model)
        self._records = {}
        self._executed = []
        self._capsules = {}
        self._cache.clear()
        self._root = None
        self._packet_count = 0
        self._tree_id = digest(self.layout.tree.to_dict())
        self.costs.index_build_bytes += len(canonical(self._positions)) + len(self.layout.manifest_bytes())
        self.costs.index_build_seconds += _now() - started

    def _ingest(self, snapshot):
        started = _now()
        for cid in snapshot.executed[len(self._executed):]:
            rec = json.loads(json.dumps(snapshot.records[cid]))
            position = self._positions[cid]
            evidence = Evidence(self._kernel.gate_binding(position), rec['status'], digest(rec))
            self._kernel.submit_trusted(position, evidence)
            self._records[cid] = rec
            self._executed.append(cid)
            self.costs.index_maintenance_bytes += len(canonical({'id': cid, **rec}))
        self._root, packets = self._kernel.refresh(self.layout.tree)
        self._packet_count = len(packets)
        self._capsules = {(node.lo, node.hi): self._kernel._cache[
            (self._tree_id, node.lo, node.hi)][1] for node in self.layout.tree.walk()}
        self.costs.index_maintenance_bytes += sum(map(len, packets))
        self.costs.storage_bytes = len(canonical({
            'records': self._records, 'positions': self._positions,
            'layout': self.layout.to_dict(),
            'capsules': [c.as_dict() for c in self._capsules.values()]}))
        self.costs.index_maintenance_seconds += _now() - started

    def record_of(self, check_id):
        if check_id not in self._positions:
            raise ValueError('missing semantic index entry')
        record = self._records.get(check_id)
        if record is not None:
            self.costs.aggregation_bytes_scanned += len(canonical(record))
            self.costs.aggregation_cpu_calls += 1
        return record

    def _counts(self, selected):
        wanted = {self._positions[cid] for cid in selected}
        prefix = [0]
        for position in range(len(self.trajectory.registry)):
            prefix.append(prefix[-1] + int(position in wanted))
        counts = [0, 0, 0]
        def visit(node):
            number = prefix[node.hi + 1] - prefix[node.lo]
            if not number:
                return
            if number == node.hi - node.lo + 1:
                capsule = self._capsules[(node.lo, node.hi)]
                for i, value in enumerate(capsule.counts):
                    counts[i] += value
                self.costs.aggregation_cpu_calls += 1
                self.costs.aggregation_bytes_scanned += len(capsule.to_bytes())
            else:
                for child in node.children:
                    visit(child)
        visit(self.layout.tree)
        return dict(zip(core.STATUS_ORDER, counts))

    def _extras(self):
        return {'kernel_counts': list(self._root.counts),
                'kernel_gates': len(self._kernel.gates),
                'kernel_verdict': self._root.verdict, 'packet_count': self._packet_count}


def frozen_queries():
    return [
        {'query_id': 'Q1', 's': 'all', 'mode': 'status'},
        {'query_id': 'Q2', 's': 'failing', 'mode': 'failure_localization'},
        {'query_id': 'Q3', 's': 'unfinished', 'mode': 'status'},
        {'query_id': 'Q4', 's': 'all', 'mode': 'coverage_proof'},
        {'query_id': 'Q5', 's': 'all', 'mode': 'replay', 'wave': 0},
        {'query_id': 'Q6a', 's': 'unit', 'mode': 'status'},
        {'query_id': 'Q6b', 's': 'integration', 'mode': 'status'},
    ]


def build_layout(trajectory, order=None, model=None):
    from ichact.practical import balanced_layout
    return balanced_layout(trajectory.registry, order=None if order is None else tuple(order),
                           model=model or CostModel())
