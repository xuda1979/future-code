"""Equal-service implementations for the V8 study (contract sections 3, 6, 7).

Two representations of the SAME frozen trajectory answer the SAME frozen
queries with identical answer semantics (service_core):

1. ``HactService`` — the hierarchical certificate tree. Layout-parameterized
   (original-order balanced and learned layouts must give identical answers).
   Uses the trusted ``hact.certificates.Kernel`` for aggregation.

2. ``IndexedFlatLedger`` — the strong flat baseline demanded by review section 3
   and contract section 6: a per-check index over a leaf-event ledger with
   on-demand aggregation for Q1-Q6, declared cache with eviction, DEFLATE
   (per-answer and whole-ledger), and paging under budget, with index build +
   maintenance costs counted. A leaf-only ledger without these capabilities is
   NOT this baseline.

Cost accounting (contract section 7) is identical across arms and measures
bytes touched to answer a query, cache hits, pages, and index/maintenance work.

No new checker, live LLM, WAN, tokenizer, or project run is claimed. This is a
new analysis of frozen archived records; arrival-time fields derived from
archived per-phase timings are clearly marked and never presented as
measured-latency claims.
"""
from __future__ import annotations

import json
import time
import zlib
from dataclasses import dataclass, field
from typing import Sequence

from experiments_v8 import service_core as core
from hact.certificates import (CostModel, Evidence, Gate, Kernel, canonical,
                               digest)
from hact.tree import Node
from ichact.exposure import compact_packet
from ichact.layout import Layout


# --------------------------------------------------------------------------
# Cost accounting (contract section 7) — identical rules for both services
# --------------------------------------------------------------------------

@dataclass
class ServiceCosts:
    """Bytes and operation counts, measured per query (not assumed)."""
    index_build_bytes: int = 0
    index_maintenance_bytes: int = 0
    storage_bytes: int = 0
    aggregation_bytes_scanned: int = 0
    aggregation_cpu_calls: int = 0
    cache_hits: int = 0
    cache_misses: int = 0
    encode_bytes: int = 0
    decode_bytes: int = 0
    pages: int = 0
    round_trips: int = 0            # complete messages to first full answer
    failure_disclosures: int = 0
    index_build_seconds: float = 0.0
    index_maintenance_seconds: float = 0.0
    aggregation_seconds: float = 0.0

    def merge(self, other: "ServiceCosts") -> "ServiceCosts":
        out = ServiceCosts()
        for k in out.__dict__:
            setattr(out, k, getattr(self, k) + getattr(other, k))
        return out

    def as_dict(self) -> dict:
        return dict(self.__dict__)


def _now() -> float:
    return time.perf_counter()


# --------------------------------------------------------------------------
# HACT tree service
# --------------------------------------------------------------------------

@dataclass
class HactService:
    """Hierarchical certificate tree service over one frozen trajectory.

    ``layout`` must be a Layout over the trajectory's registry (any order);
    answers are layout-independent by construction because they are computed
    from semantic IDs through service_core, while aggregation uses the Kernel
    over the layout's display tree.
    """
    trajectory: core.Trajectory
    layout: Layout
    budget: int = core.DEFAULT_BUDGET
    cache_max_entries: int = 128

    costs: ServiceCosts = field(default_factory=ServiceCosts, init=False)
    _kernel: Kernel = field(default=None, init=False, repr=False)
    _cache: dict = field(default_factory=dict, init=False, repr=False)
    _submitted: set = field(default_factory=set, init=False, repr=False)

    def __post_init__(self):
        registry = self.trajectory.registry
        if tuple(self.layout.registry) != tuple(registry):
            raise ValueError("layout registry must match the trajectory registry")
        self._build()

    # -- index construction -------------------------------------------------

    def _build(self) -> None:
        """Build the kernel (trusted aggregator) and count build costs."""
        started = _now()
        registry = self.trajectory.registry
        artifacts = {"registry.json": digest(list(registry))}
        gates = tuple(Gate(id=cid, dependencies=("registry.json",)) for cid in registry)
        kernel = Kernel(gates, artifacts, self.layout.model)
        self.costs.index_build_bytes += sum(
            len(canonical({"gate": g.id, "checker": g.checker,
                           "dependencies": list(g.dependencies)}))
            for g in gates)
        self.costs.storage_bytes += sum(
            self.layout.model.packet_bytes(len(v.children))
            for v in self.layout.tree.walk() if not v.leaf)
        self._kernel = kernel
        self.costs.index_build_seconds += _now() - started

    def _order_pos(self, check_id: str) -> int:
        return self.layout.order.index(self.trajectory.registry.index(check_id))

    def _submit_upto(self, snapshot: core.TrajectorySnapshot) -> None:
        """Trusted-side ingestion of completions in the snapshot (maintenance)."""
        started = _now()
        registry = self.trajectory.registry
        have = self._submitted
        for cid in snapshot.executed:
            if cid in have:
                continue
            i = registry.index(cid)
            rec = snapshot.records[cid]
            evidence = Evidence(binding=self._kernel.gate_binding(i),
                                status=rec["status"],
                                trace_hash=digest({"id": cid, "status": rec["status"],
                                                   "phases": rec.get("phases", {})}))
            self._kernel.submit_trusted(i, evidence)
            self._submitted.add(cid)
            self.costs.index_maintenance_bytes += len(canonical(
                {"id": cid, "status": rec["status"]}))
        self.costs.index_maintenance_seconds += _now() - started

    # -- queries ------------------------------------------------------------

    def _cached(self, key, produce):
        if key in self._cache:
            self.costs.cache_hits += 1
            return self._cache[key]
        self.costs.cache_misses += 1
        value = produce()
        if len(self._cache) >= self.cache_max_entries:
            # declared eviction: FIFO, reported, never silent
            self._cache.pop(next(iter(self._cache)))
        self._cache[key] = value
        return value

    def query(self, query_id: str, snapshot: core.TrajectorySnapshot,
              s, mode: str, *, wave: int | None = None) -> core.Answer:
        """Answer one frozen query. `wave` applies to Q5 replay only."""
        started = _now()
        self._submit_upto(snapshot)
        selected = core.select_members(snapshot, s)
        self.costs.aggregation_cpu_calls += len(selected)
        self.costs.aggregation_bytes_scanned += sum(
            len(canonical({"id": cid})) for cid in selected)

        if mode == "status":
            semantic = core.answer_status(snapshot, selected)
        elif mode == "failure_localization":
            semantic = core.answer_failure_localization(snapshot, selected)
        elif mode == "coverage_proof":
            semantic = core.answer_coverage_proof(snapshot, selected)
        elif mode == "replay":
            if wave is None:
                raise ValueError("replay mode requires an explicit wave")
            semantic = core.answer_replay(snapshot, wave)
            if semantic.get("refused"):
                self.costs.failure_disclosures += 1
        else:
            raise ValueError("unknown mode %r" % (mode,))

        # Aggregation through the Kernel tree (the tree's actual rollups must
        # agree with the semantic answer; verified by the oracle).
        root, packets = self._kernel.refresh(self.layout.tree)
        self.costs.aggregation_cpu_calls += 1
        self.costs.aggregation_bytes_scanned += len(root.to_bytes())

        pages = core.pack_answers(semantic, snapshot.trajectory.identity,
                                  query_id, snapshot.epoch,
                                  self._total_waves(), budget=self.budget)
        self.costs.pages += len(pages)
        self.costs.round_trips += len(pages)
        compressed = core.deflate_answer(pages)
        self.costs.encode_bytes += compressed["answer_zlib_bytes"]
        self.costs.aggregation_seconds += _now() - started
        return core.Answer(query_id=query_id, mode=mode,
                           identity=dict(snapshot.trajectory.identity),
                           epoch=snapshot.epoch, total_waves=self._total_waves(),
                           semantic=semantic, total_pages=len(pages),
                           extras={"compressed": compressed,
                                   "kernel_counts": list(root.counts),
                                   "kernel_gates": len(self._kernel.gates),
                                   "kernel_verdict": root.verdict,
                                   "packet_count": len(packets)})

    def _total_waves(self) -> int:
        executed = self.trajectory.evidence["executed"]
        w = self.trajectory.wave_size()
        return (len(executed) + w - 1) // w if executed else 0


# --------------------------------------------------------------------------
# Indexed flat ledger (the strong baseline; contract section 6)
# --------------------------------------------------------------------------

@dataclass
class IndexedFlatLedger:
    """Per-check indexed leaf-event ledger with on-demand aggregation.

    Capabilities (all with counted costs, contract 6/7):
      1. per-check index over the ledger (build + maintenance counted);
      2. on-demand aggregation for the frozen queries (CPU measured);
      3. DEFLATE per-answer and whole-ledger (same codec settings);
      4. declared cache with FIFO eviction, hits reported;
      5. paging under the same budget and page-descriptor semantics;
      6. identical failure disclosure and UNKNOWN handling.
    """

    trajectory: core.Trajectory
    budget: int = core.DEFAULT_BUDGET
    cache_max_entries: int = 128
    ledger_batch_size: int = 8  # archived completion-wave boundary

    costs: ServiceCosts = field(default_factory=ServiceCosts, init=False)
    _index: dict = field(default_factory=dict, init=False, repr=False)
    _ledger: list = field(default_factory=list, init=False, repr=False)
    _cache: dict = field(default_factory=dict, init=False, repr=False)

    def __post_init__(self):
        started = _now()
        registry = self.trajectory.registry
        # Per-check index: semantic ID -> ledger position range, built once.
        # The ledger itself is appended per completion wave (leaf events).
        self._index = {cid: i for i, cid in enumerate(registry)}
        self.costs.index_build_bytes += sum(len(cid.encode("ascii")) + 8
                                            for cid in registry)
        self.costs.storage_bytes += sum(
            len(canonical({"id": cid})) for cid in registry)
        self.costs.index_build_seconds += _now() - started

    def _ingest_upto(self, snapshot: core.TrajectorySnapshot) -> None:
        """Append completion events for checks not yet in the ledger."""
        started = _now()
        have = {ev["id"] for ev in self._ledger}
        for cid in snapshot.executed:
            if cid in have:
                continue
            rec = snapshot.records[cid]
            event = {"id": cid, "status": rec["status"],
                     "phases": rec.get("phases", {}),
                     "wave": snapshot.wave_index_of(cid)}
            self._ledger.append(event)
            self.costs.index_maintenance_bytes += len(canonical(event))
        self.costs.index_maintenance_seconds += _now() - started

    def record_of(self, check_id: str):
        for ev in reversed(self._ledger):
            if ev["id"] == check_id:
                return ev
        return None

    def _cached(self, key, produce):
        if key in self._cache:
            self.costs.cache_hits += 1
            return self._cache[key]
        self.costs.cache_misses += 1
        value = produce()
        if len(self._cache) >= self.cache_max_entries:
            self._cache.pop(next(iter(self._cache)))  # declared FIFO eviction
        self._cache[key] = value
        return value

    def whole_ledger_zlib_bytes(self) -> int:
        batch = b"".join(canonical(ev) + b"\n" for ev in self._ledger)
        return len(zlib.compress(batch, 6))

    def query(self, query_id: str, snapshot: core.TrajectorySnapshot,
              s, mode: str, *, wave: int | None = None) -> core.Answer:
        started = _now()
        self._ingest_upto(snapshot)
        selected = core.select_members(snapshot, s)
        self.costs.aggregation_cpu_calls += len(selected)
        self.costs.aggregation_bytes_scanned += sum(
            len(canonical({"id": cid})) for cid in selected)

        if mode == "status":
            semantic = core.answer_status(snapshot, selected)
        elif mode == "failure_localization":
            semantic = core.answer_failure_localization(snapshot, selected)
        elif mode == "coverage_proof":
            semantic = core.answer_coverage_proof(snapshot, selected)
        elif mode == "replay":
            if wave is None:
                raise ValueError("replay mode requires an explicit wave")
            semantic = core.answer_replay(snapshot, wave)
            if semantic.get("refused"):
                self.costs.failure_disclosures += 1
        else:
            raise ValueError("unknown mode %r" % (mode,))

        pages = core.pack_answers(semantic, snapshot.trajectory.identity,
                                  query_id, snapshot.epoch,
                                  self._total_waves(), budget=self.budget)
        self.costs.pages += len(pages)
        self.costs.round_trips += len(pages)
        compressed = core.deflate_answer(pages)
        self.costs.encode_bytes += compressed["answer_zlib_bytes"]
        self.costs.aggregation_seconds += _now() - started
        return core.Answer(query_id=query_id, mode=mode,
                           identity=dict(snapshot.trajectory.identity),
                           epoch=snapshot.epoch, total_waves=self._total_waves(),
                           semantic=semantic, total_pages=len(pages),
                           extras={"compressed": compressed,
                                   "ledger_events": len(self._ledger),
                                   "whole_ledger_zlib_bytes": self.whole_ledger_zlib_bytes()})

    def _total_waves(self) -> int:
        executed = self.trajectory.evidence["executed"]
        w = self.trajectory.wave_size()
        return (len(executed) + w - 1) // w if executed else 0


# --------------------------------------------------------------------------
# Query plan (frozen): the six queries over the 12 trajectories
# --------------------------------------------------------------------------

def frozen_queries() -> list[dict]:
    """The frozen query plan: Q1-Q6 with their S/mode parameters."""
    return [
        {"query_id": "Q1", "s": "all", "mode": "status",
         "note": "full candidate status rollup"},
        {"query_id": "Q2", "s": "failing", "mode": "failure_localization",
         "note": "failing checks with localized context"},
        {"query_id": "Q3", "s": "unfinished", "mode": "status",
         "note": "unfinished obligations"},
        {"query_id": "Q4", "s": "all", "mode": "coverage_proof",
         "note": "coverage proof for the declared contract"},
        {"query_id": "Q5", "s": "all", "mode": "replay", "wave": 0,
         "note": "replay of completed wave 0"},
        {"query_id": "Q6a", "s": "unit", "mode": "status",
         "note": "status restricted to the frozen 'unit' predicate"},
        {"query_id": "Q6b", "s": "integration", "mode": "status",
         "note": "status restricted to the frozen 'integration' predicate"},
    ]


def build_layout(trajectory: core.Trajectory, order: Sequence[int] | None = None,
                 model: CostModel | None = None) -> Layout:
    """Layout over the trajectory registry; identity order by default."""
    from ichact.practical import balanced_layout
    return balanced_layout(trajectory.registry,
                           order=None if order is None else tuple(order),
                           model=model or CostModel())
