"""Shared semantic answer layer for the V8 equal-service study.

Everything in this module is representation-independent: it defines the frozen
query semantics Q(e, S, mode, budget) of docs/V8_SERVICE_CONTRACT.md in terms
of a *record store* abstraction. Both the hierarchical HACT service and the
indexed flat-ledger service must produce answers whose semantic content is
computed through these functions, so the equivalence oracle compares like with
like and any difference is attributable to the representation, not to drifting
answer semantics.

No new checker, live LLM, WAN, tokenizer, or project run is claimed. This is a
new analysis of frozen archived records.
"""
from __future__ import annotations

import hashlib
import json
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Mapping, Sequence

ROOT = Path(__file__).resolve().parents[1]
CORPUS_ROOT = ROOT / "results" / "v3" / "fresh_checkers"

# The 12 archived v5 candidates (3 projects x 4 candidates), frozen.
TRAJECTORY_IDS = (
    ("networkx", "networkx_confirm_%03d" % i) for i in range(4)
)
CORPUS = tuple(
    [("networkx", "networkx_confirm_%03d" % i) for i in range(4)]
    + [("toolz", "toolz_confirm_%03d" % i) for i in range(9, 13)]
    + [("future", "future_confirm_%03d" % i) for i in range(15, 19)]
)

STATUS_ORDER = ("PASS", "FAIL", "UNKNOWN")
SCHEMA = "v8-service-answers-1"

DEFAULT_BUDGET = 16384
DEFAULT_WAVE_SIZE = 8  # archived completion-wave size (v3/v5 replay batches)


# --------------------------------------------------------------------------
# Identity (contract section 1)
# --------------------------------------------------------------------------

def identity(report: Mapping) -> dict:
    """e = (candidate_id, checker, environment, registry_hash)."""
    return {
        "snapshot": report["snapshot"],
        "checker": report["checker"],
        "environment": report["environment"],
        "registry_hash": report["registry_hash"],
    }


# --------------------------------------------------------------------------
# Frozen predicates over semantic IDs (contract section 1: S)
# --------------------------------------------------------------------------

def _file_part(check_id: str) -> str:
    return check_id.split("::", 1)[0]


def predicate_unit(check_id: str) -> bool:
    """Frozen Q6 'unit' predicate: the test lives under a tests/ directory."""
    return "/tests/" in _file_part(check_id) or _file_part(check_id).startswith("tests/")


def predicate_integration(check_id: str) -> bool:
    return not predicate_unit(check_id)


PREDICATES = {
    "all": lambda _cid: True,
    "failing": None,        # special-cased: depends on the snapshot, not the ID
    "unfinished": None,     # special-cased: depends on the snapshot, not the ID
    "unit": predicate_unit,
    "integration": predicate_integration,
}


def evaluate_predicate(name: str, check_id: str, snapshot: "TrajectorySnapshot") -> bool:
    if name == "failing":
        rec = snapshot.record_of(check_id)
        return rec is not None and rec["status"] == "FAIL"
    if name == "unfinished":
        return snapshot.record_of(check_id) is None
    try:
        fn = PREDICATES[name]
    except KeyError:
        raise ValueError("unknown frozen predicate: %r" % (name,)) from None
    return fn(check_id)


# --------------------------------------------------------------------------
# Trajectory + snapshots (contract section 4)
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Trajectory:
    """An ordered sequence of trusted completion records for candidate e."""
    project: str
    case: str
    evidence: dict          # archived pytest_evidence.json
    report: dict            # archived report.json
    registry: tuple         # ordered semantic IDs (the declared obligation set)

    @property
    def identity(self) -> dict:
        return identity(self.report)

    @property
    def n(self) -> int:
        return len(self.registry)

    @classmethod
    def from_dir(cls, project: str, case: str, directory: Path) -> "Trajectory":
        evidence = json.loads((directory / "pytest_evidence.json").read_text())
        report = json.loads((directory / "report.json").read_text())
        return cls(project=project, case=case, evidence=evidence, report=report,
                   registry=tuple(evidence["registry"]))

    @classmethod
    def load(cls, project: str, case: str, root: Path = CORPUS_ROOT,
             suffix: str = "-fixed8") -> "Trajectory":
        directory = Path(root) / project / (case + suffix)
        if not directory.is_dir():
            raise FileNotFoundError(str(directory))
        return cls.from_dir(project, case, directory)

    def wave_size(self) -> int:
        """Frozen completion-wave size used by the archived replay."""
        return DEFAULT_WAVE_SIZE

    def snapshot(self, upto_wave: int | None = None) -> "TrajectorySnapshot":
        """Immutable snapshot of the trajectory up to a stated wave (inclusive)."""
        return TrajectorySnapshot.of(self, upto_wave)


@dataclass(frozen=True)
class TrajectorySnapshot:
    """Answers are computed against this; it carries the epoch (contract 4)."""
    trajectory: Trajectory
    upto_wave: int            # inclusive; None means 'through the final wave'
    executed: tuple           # ordered completions in the snapshot
    records: Mapping          # check_id -> archived record (statuses/phases)

    @classmethod
    def of(cls, trajectory: Trajectory, upto_wave: int | None) -> "TrajectorySnapshot":
        executed_all = list(trajectory.evidence["executed"])
        w = trajectory.wave_size()
        total_waves = (len(executed_all) + w - 1) // w if executed_all else 0
        if upto_wave is None:
            upto = total_waves
        else:
            if not isinstance(upto_wave, int) or upto_wave < 0:
                raise ValueError("wave index must be a non-negative integer")
            upto = min(upto_wave, total_waves)
        executed = tuple(executed_all[: upto * w])
        records = {k: trajectory.evidence["records"][k] for k in executed}
        return cls(trajectory=trajectory, upto_wave=upto, executed=executed, records=records)

    @property
    def epoch(self) -> int:
        return self.upto_wave

    @property
    def registry(self) -> tuple:
        return self.trajectory.registry

    def record_of(self, check_id: str):
        return self.records.get(check_id)

    def status_of(self, check_id: str) -> str:
        rec = self.records.get(check_id)
        return rec["status"] if rec is not None else "UNKNOWN"

    def wave_index_of(self, check_id: str):
        try:
            pos = self.executed.index(check_id)
        except ValueError:
            return None
        return pos // self.trajectory.wave_size()


# --------------------------------------------------------------------------
# Semantic answers (contract sections 2-4)
# --------------------------------------------------------------------------

def _phase_outcome(rec: Mapping) -> dict:
    phases = rec.get("phases") or {}
    return {
        name: {
            "outcome": (phases.get(name) or {}).get("outcome"),
        }
        for name in ("setup", "call", "teardown")
        if name in phases or (phases.get(name) or {})
    }


def _localized_context(rec: Mapping) -> str:
    """Frozen localization context: the recorded failure excerpt if present."""
    return rec.get("failure") or ""


@dataclass
class Answer:
    """One complete answer to Q(e, S, mode, budget)."""
    query_id: str
    mode: str
    identity: dict
    epoch: int
    total_waves: int
    semantic: dict                     # representation-independent content
    page: int = 1
    total_pages: int = 1
    complete: bool = True
    fresh: bool = True                 # False => stale-epoch rejection (contract 4)
    stale_disclosure: dict | None = None
    extras: dict = field(default_factory=dict)

    def key(self):
        return (self.query_id, self.epoch, self.page)


def answer_status(snapshot: TrajectorySnapshot, selected: Sequence[str]) -> dict:
    """Q1/Q6 core: verdict + counts + unfinished, restricted to `selected`."""
    counts = {s: 0 for s in STATUS_ORDER}
    unfinished = []
    for cid in selected:
        rec = snapshot.record_of(cid)
        if rec is None:
            counts["UNKNOWN"] += 1
            unfinished.append(cid)
        else:
            counts[rec["status"]] += 1
    verdict = ("FAIL" if counts["FAIL"]
               else "UNKNOWN" if counts["UNKNOWN"] else "PASS")
    return {
        "required": len(selected),
        "counts": counts,
        "verdict": verdict,
        "unfinished": unfinished,
    }


def answer_failure_localization(snapshot: TrajectorySnapshot,
                                selected: Sequence[str]) -> dict:
    """Q2 core: failing checks with localized context and phase outcomes."""
    failing = []
    groups: dict[str, list[str]] = {}
    for cid in selected:
        rec = snapshot.record_of(cid)
        if rec is None or rec["status"] != "FAIL":
            continue
        failing.append({
            "id": cid,
            "phase_outcomes": _phase_outcome(rec),
            "context": _localized_context(rec),
        })
        groups.setdefault(_file_part(cid), []).append(cid)
    return {
        "failing_count": len(failing),
        "failing": failing,
        "groups": {k: sorted(v) for k, v in sorted(groups.items())},
    }


def answer_coverage_proof(snapshot: TrajectorySnapshot,
                          selected: Sequence[str]) -> dict:
    """Q4 core: declared set, what ran, what did not, authorization state."""
    declared = list(selected)
    executed = [cid for cid in declared if snapshot.record_of(cid) is not None]
    missing = [cid for cid in declared if snapshot.record_of(cid) is None]
    all_passed = all(snapshot.status_of(cid) == "PASS" for cid in declared)
    authorized = bool(snapshot.trajectory.report.get("locally_authorized")) and all_passed
    return {
        "declared": len(declared),
        "executed": len(executed),
        "missing": missing,
        "all_declared_passed": all_passed,
        "eligible_authorization": authorized,
        "scope": ("All declared checks passed for the declared contract; this is "
                  "not a claim that the check set suffices for arbitrary "
                  "program correctness."),
    }


def answer_replay(snapshot: TrajectorySnapshot, wave: int) -> dict:
    """Q5 core: re-derive a recorded wave's rollup from per-check records."""
    w = snapshot.trajectory.wave_size()
    executed_all = list(snapshot.trajectory.evidence["executed"])
    if not isinstance(wave, int) or wave < 0 or wave * w >= len(executed_all):
        raise ValueError("unknown wave %r for replay" % (wave,))
    if wave > snapshot.epoch:
        # Asking to replay a wave beyond the stated epoch is a stale/foreign
        # request: refused with an explicit disclosure (contract 4), never
        # silently upgraded to a newer snapshot.
        return {
            "refused": True,
            "reason": "wave beyond stated epoch",
            "wave": wave,
            "epoch": snapshot.epoch,
        }
    members = executed_all[wave * w: (wave + 1) * w]
    counts = {s: 0 for s in STATUS_ORDER}
    for cid in members:
        counts[snapshot.status_of(cid)] += 1
    return {
        "refused": False,
        "wave": wave,
        "members": list(members),
        "counts": counts,
        "wall_seconds_total": sum(
            snapshot.trajectory.evidence["records"][cid].get("wall_seconds", 0.0)
            for cid in members),
    }


def select_members(snapshot: TrajectorySnapshot, s: str | Sequence[str]) -> list[str]:
    """Resolve S (predicate name or explicit semantic ID list) to registry members."""
    if isinstance(s, str):
        name = s
        if name in ("failing", "unfinished", "unit", "integration", "all"):
            return [cid for cid in snapshot.registry
                    if evaluate_predicate(name, cid, snapshot)]
        # an explicit single semantic ID
        if name in snapshot.registry:
            return [name]
        raise ValueError("unknown semantic set or member: %r" % (name,))
    ids = list(s)
    reg = snapshot.registry
    for cid in ids:
        if cid not in reg:
            raise ValueError("unknown semantic member: %r" % (cid,))
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate semantic members in S")
    return ids


# --------------------------------------------------------------------------
# Paging + encoding (contract sections 1 and 7)
# --------------------------------------------------------------------------

def page_descriptor(answer: Answer) -> dict:
    return {"page": answer.page, "total_pages": answer.total_pages,
            "complete": answer.complete}


def pack_answers(semantic: dict, identity: dict, query_id: str, epoch: int,
                 total_waves: int, budget: int = DEFAULT_BUDGET,
                 extra_pages: Sequence[dict] | None = None) -> list[bytes]:
    """Serialize one complete answer into budget-bounded pages.

    The first page carries the full answer header; continuation pages carry
    the page descriptor and a slice of the paged payload. Never truncates
    silently: the final page count reflects the complete answer.
    """
    if not isinstance(budget, int) or budget < 1:
        raise ValueError("budget must be a positive integer")

    def frame(payload: dict) -> bytes:
        return json.dumps(payload, sort_keys=True, separators=(",", ":"),
                          ensure_ascii=True).encode("ascii") + b"\n"

    header = {"schema": SCHEMA, "query": query_id, "epoch": epoch,
              "total_waves": total_waves, "identity": identity}
    body_keys = [k for k in sorted(semantic)]
    pages: list[bytes] = []

    def emit(payloads: Sequence[dict]) -> None:
        """Emit payload pages under budget, with page descriptors.

        The header page (page 1) is emitted by the caller before this runs;
        payload pages are numbered from 2. A payload frame that alone exceeds
        the budget still gets its own page (never silently truncated); that
        page then exceeds the budget as a declared oversize frame.
        """
        packed = [frame(payload) for payload in payloads]

        def plan(frames: Sequence[bytes]) -> list[list[bytes]]:
            """Greedy packing: start a new page when the budget is exceeded."""
            out: list[list[bytes]] = []
            current: list[bytes] = []
            size = 0
            for raw in frames:
                if current and size + len(raw) > budget:
                    out.append(current)
                    current, size = [], 0
                current.append(raw)
                size += len(raw)
            if current:
                out.append(current)
            return out or [[]]

        body_pages = plan(packed)
        total = 1 + len(body_pages)  # page 1 is the header page
        for page_no, chunk in enumerate(body_pages, start=2):
            desc = frame({"page": page_no, "total_pages": total})
            pages.append(desc + b"".join(chunk))

    # Split large list-valued fields into per-item payloads (deterministic).
    payloads: list[dict] = []
    for key in body_keys:
        value = semantic[key]
        if isinstance(value, list) and len(frame({key: value})) > budget:
            # page this list item-by-item
            for item in value:
                payloads.append({key: [item]})
        else:
            payloads.append({key: value})
    header_frame = frame({"header": header})
    if len(header_frame) > budget:
        raise ValueError("mandatory answer header exceeds budget; never truncate")
    pages.append(header_frame)
    emit(payloads)
    return pages


def deflate_answer(pages: Sequence[bytes]) -> dict:
    """Per-answer DEFLATE and (for reference) batch DEFLATE (contract 7)."""
    batch = b"".join(pages)
    return {
        "raw_bytes": len(batch),
        "answer_zlib_bytes": len(zlib.compress(batch, 6)),
    }


def sha256_pages(pages: Sequence[bytes]) -> str:
    return hashlib.sha256(b"".join(pages)).hexdigest()


def semantic_digest(semantic: dict) -> str:
    return hashlib.sha256(
        json.dumps(semantic, sort_keys=True, separators=(",", ":"),
                   ensure_ascii=True).encode("ascii")
    ).hexdigest()


def strip_run_specific(semantic: dict) -> dict:
    """Project out run-specific timing noise for cross-run comparisons.

    Wall-clock and phase seconds are properties of the recorded execution,
    not of the representation or the layout; the equivalence oracle compares
    them only within the same evidence run.
    """
    out = json.loads(json.dumps(semantic))  # deep copy
    out.pop("wall_seconds_total", None)
    return out
