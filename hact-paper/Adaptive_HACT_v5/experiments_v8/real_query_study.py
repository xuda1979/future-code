"""P0-3 real-query study: full cost measurement over the frozen query
workload (V8_SERVICE_CONTRACT.md sections 3, 7, 9; V8_MAJOR_REVISION_PLAN.md
section 3.3).

Both representations of the SAME frozen trajectory answer the SAME frozen
queries with identical answer semantics (service_core). This module measures,
per query, per representation:

  * complete-answer bytes (sum of all page frames, and DEFLATEd bytes);
  * round trips (logical complete messages to first full answer);
  * all maintenance costs (index build + maintenance, storage);
  * aggregation work (CPU calls, bytes scanned, measured CPU seconds);
  * complete-answer arrival time derived ONLY from archived per-phase
    timings (never measured-latency claims; clearly marked arithmetic).

The decision rule (contract section 9, frozen) is applied per query family:
HACT is beneficial iff complete-answer bytes AND complete-answer arrival time
improve against the indexed flat ledger with all maintenance costs included.
Negative results are published as-is.

Arrival-time model (declared, arithmetic, from archived data only)
------------------------------------------------------------------
The archived evidence records per check the phase seconds (setup/call/
teardown) and pytest wall seconds of the ORIGINAL execution. A completion
wave completes at the max end time of its member checks. Because both
representations read the same records, the answer for a query that needs
only waves up to W can arrive no earlier than the archived completion time
of wave W, plus the representation-specific aggregation/encoding work (the
CPU seconds this module measures) plus the serialization bytes at the
declared link rate. The model is:

    arrival = archived_completion_time(W)            (same for both arms)
            + aggregation_cpu_seconds (measured here)
            + complete_answer_bytes / LINK_BYTES_PER_SECOND (declared)

with LINK_BYTES_PER_SECOND a declared constant (see LINK_BYTES_PER_SECOND).
The archived-completion term is identical across arms, so the difference in
arrival time reduces to measured CPU + bytes/declared-rate; both are
reported so the reader can re-derive the decision under any link rate.
Where archived timings do not permit this derivation the arrival entry is
marked "simulated": false and excluded from the time decision ("bytes only",
with the limitation stated, contract section 9).
"""

from __future__ import annotations

import json
import random
import statistics
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping, Sequence

from experiments_v8 import service_baselines as sb
from experiments_v8 import service_core as core

ROOT = Path(__file__).resolve().parent.parent

# Declared link rate for the arithmetic arrival model (contract section 7:
# "clearly marked simulated/arithmetic, never measured-latency claims").
# 1 MiB/s is the same order as the WAN protocol's declared reference rate.
LINK_BYTES_PER_SECOND = 1_048_576

# Fixed seed for the workload generator (plan section 3.3: "publish the
# query generator with fixed seeds"). Any change to the derived workload
# requires a new frozen contract entry, not a silent seed change.
WORKLOAD_SEED = 20261009


# --------------------------------------------------------------------------
# Workload generation (frozen, derived from the archived trajectories)
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class WorkloadQuery:
    """One query instance in the study workload."""
    query_id: str          # Q1..Q6b
    s: object              # semantic set (predicate name or explicit IDs)
    mode: str
    wave: int | None = None  # replay wave (Q5 only)
    origin: str = "frozen"   # "frozen" | "derived:<note>"


def failing_cases() -> list[tuple[str, str]]:
    """The 9 archived trajectories with at least one FAIL (for Q2)."""
    out = []
    for project, case in core.CORPUS:
        t = core.Trajectory.load(project, case)
        if any(t.evidence["records"][c]["status"] == "FAIL"
               for c in t.evidence["executed"]):
            out.append((project, case))
    return out


def study_workload() -> dict[tuple[str, str], list[WorkloadQuery]]:
    """The frozen study workload: per trajectory, the queries to run.

    For every one of the 12 archived trajectories:
      Q1  status(all)                      -- candidate rollup
      Q4  coverage_proof(all)              -- declared/executed/missing
      Q6a status(unit)                     -- predicate-restricted
      Q6b status(integration)              -- predicate-restricted
      Q5  replay(wave=0)                   -- recorded wave rollup
      Q2  failure_localization(failing)    -- only for the 9 failing runs
      Q5+ replay(wave=k) for a fixed-seed sample of k in [1, W-1]
                                          -- "real" replay needs beyond wave 0
    """
    rng = random.Random(WORKLOAD_SEED)
    workload: dict[tuple[str, str], list[WorkloadQuery]] = {}
    failing = set(failing_cases())
    for project, case in core.CORPUS:
        t = core.Trajectory.load(project, case)
        executed_n = len(t.evidence["executed"])
        total_waves = ((executed_n + t.wave_size() - 1) // t.wave_size()
                       if executed_n else 0)
        queries = [
            WorkloadQuery("Q1", "all", "status"),
            WorkloadQuery("Q4", "all", "coverage_proof"),
            WorkloadQuery("Q6a", "unit", "status"),
            WorkloadQuery("Q6b", "integration", "status"),
            WorkloadQuery("Q5", "all", "replay", wave=0),
        ]
        if (project, case) in failing:
            queries.append(WorkloadQuery("Q2", "failing", "failure_localization"))
        if total_waves > 1:
            # fixed-seed extra replay waves beyond 0
            extra = sorted(rng.sample(range(1, total_waves),
                                      k=min(2, total_waves - 1)))
            for w in extra:
                queries.append(WorkloadQuery("Q5", "all", "replay", wave=w,
                                             origin="derived:seeded-replay"))
        workload[(project, case)] = queries
    return workload


# --------------------------------------------------------------------------
# Per-query measurement
# --------------------------------------------------------------------------

@dataclass
class QueryCosts:
    """Measured costs for one query on one representation."""
    representation: str          # "hact" | "indexed_flat"
    complete_answer_bytes: int = 0   # sum of page frames (uncompressed)
    compressed_answer_bytes: int = 0  # DEFLATEd complete answer
    round_trips: int = 0
    pages: int = 0
    aggregation_cpu_calls: int = 0
    aggregation_bytes_scanned: int = 0
    aggregation_seconds: float = 0.0
    # maintenance (charged to the arm; contract section 7)
    index_build_bytes: int = 0
    index_maintenance_bytes: int = 0
    storage_bytes: int = 0
    index_build_seconds: float = 0.0
    index_maintenance_seconds: float = 0.0
    cache_hits: int = 0
    cache_misses: int = 0
    failure_disclosures: int = 0

    def as_dict(self) -> dict:
        return dict(self.__dict__)


def _measure_arm(arm: str, service, snapshot, q: WorkloadQuery,
                 costs: QueryCosts, first_query: bool = False) -> core.Answer:
    """Run one query, capture the measured answer and the cost deltas.

    With ``first_query`` the baseline is zero, so the row also carries the
    one-time construction costs (index build + initial storage): the service
    stands up at first use, and the frozen rule requires maintenance included.
    """
    before = ({k: 0 for k in service.costs.as_dict()} if first_query
              else service.costs.as_dict())
    answer = service.query(q.query_id, snapshot, q.s, q.mode, wave=q.wave)
    after = service.costs.as_dict()

    def delta(k: str) -> float:
        return after[k] - before[k]

    costs.complete_answer_bytes = answer.extras["compressed"]["raw_bytes"]
    costs.compressed_answer_bytes = answer.extras["compressed"]["answer_zlib_bytes"]
    costs.round_trips = int(delta("round_trips"))
    costs.pages = int(delta("pages"))
    costs.aggregation_cpu_calls = int(delta("aggregation_cpu_calls"))
    costs.aggregation_bytes_scanned = int(delta("aggregation_bytes_scanned"))
    costs.aggregation_seconds = float(delta("aggregation_seconds"))
    costs.index_build_bytes = int(delta("index_build_bytes"))
    costs.index_maintenance_bytes = int(delta("index_maintenance_bytes"))
    costs.storage_bytes = int(delta("storage_bytes"))
    costs.index_build_seconds = float(delta("index_build_seconds"))
    costs.index_maintenance_seconds = float(delta("index_maintenance_seconds"))
    costs.cache_hits = int(delta("cache_hits"))
    costs.cache_misses = int(delta("cache_misses"))
    costs.failure_disclosures = int(delta("failure_disclosures"))
    return answer


def _archived_wave_completion_times(trajectory: core.Trajectory) -> list[float]:
    """Archived cumulative completion time per wave (seconds).

    Derived only from archived per-record data: the archived evidence has
    per-test wall_seconds but no per-test start times, so the declared
    arithmetic is SERIAL and cumulative over the recorded execution order
    (wave k completes after the summed wall time of all checks through wave
    k). Identical for both arms; clearly arithmetic, never a
    measured-latency claim.
    """
    w = trajectory.wave_size()
    executed = trajectory.evidence["executed"]
    records = trajectory.evidence["records"]
    times: list[float] = []
    elapsed = 0.0
    for i in range(0, len(executed), w):
        members = executed[i:i + w]
        wave_span = sum(records[c].get("wall_seconds", 0.0) for c in members)
        elapsed += wave_span
        times.append(elapsed)
    return times


def _needed_waves(snapshot: core.TrajectorySnapshot, q: WorkloadQuery) -> int:
    """Number of archived waves the query's answer depends on."""
    total = snapshot.upto_wave
    if q.mode == "replay":
        return min((q.wave or 0) + 1, total)
    # status/localization/coverage read all executed records
    return total


def _arrival_seconds(costs: QueryCosts, archived_completion: float,
                     simulated: bool) -> dict:
    """The declared arithmetic arrival model (module docstring)."""
    transfer = costs.complete_answer_bytes / LINK_BYTES_PER_SECOND
    total = archived_completion + costs.aggregation_seconds + transfer
    return {
        "archived_completion_seconds": archived_completion,
        "aggregation_cpu_seconds": costs.aggregation_seconds,
        "transfer_seconds_at_declared_rate": transfer,
        "link_bytes_per_second": LINK_BYTES_PER_SECOND,
        "total_seconds": total,
        "simulated": simulated,
    }


# --------------------------------------------------------------------------
# Study driver
# --------------------------------------------------------------------------

@dataclass
class StudyRow:
    project: str
    case: str
    query_id: str
    s: str
    mode: str
    wave: int | None
    origin: str
    hact: QueryCosts
    flat: QueryCosts
    equal_semantics: bool
    hact_digest: str
    flat_digest: str
    hact_arrival: dict
    flat_arrival: dict

    def as_dict(self) -> dict:
        return {
            "project": self.project, "case": self.case,
            "query_id": self.query_id, "s": self.s, "mode": self.mode,
            "wave": self.wave, "origin": self.origin,
            "hact": self.hact.as_dict(),
            "flat": self.flat.as_dict(),
            "equal_semantics": self.equal_semantics,
            "hact_digest": self.hact_digest,
            "flat_digest": self.flat_digest,
            "hact_arrival": self.hact_arrival,
            "flat_arrival": self.flat_arrival,
        }


def run_study(include_maintenance: bool = True) -> list[StudyRow]:
    """Run the full cost study over the frozen workload.

    Both arms are constructed fresh per trajectory; maintenance (index
    build/maintenance, storage) is counted into the arm's costs by the
    service itself. ``include_maintenance`` controls whether the decision
    table additionally charges amortized maintenance (it is always recorded
    per row; the frozen rule requires it INCLUDED in the decision).
    """
    rows: list[StudyRow] = []
    for (project, case), queries in study_workload().items():
        trajectory = core.Trajectory.load(project, case)
        snapshot = trajectory.snapshot()
        layout = sb.build_layout(trajectory)
        hact = sb.HactService(trajectory=trajectory, layout=layout)
        flat = sb.IndexedFlatLedger(trajectory=trajectory)
        wave_times = _archived_wave_completion_times(trajectory)
        for i, q in enumerate(queries):
            h_costs = QueryCosts(representation="hact")
            f_costs = QueryCosts(representation="indexed_flat")
            a_hact = _measure_arm("hact", hact, snapshot, q, h_costs,
                                  first_query=(i == 0))
            a_flat = _measure_arm("flat", flat, snapshot, q, f_costs,
                                  first_query=(i == 0))
            dig_h = core.semantic_digest(core.strip_run_specific(a_hact.semantic))
            dig_f = core.semantic_digest(core.strip_run_specific(a_flat.semantic))
            n_waves = _needed_waves(snapshot, q)
            archived_completion = wave_times[n_waves - 1] if wave_times else 0.0
            row = StudyRow(
                project=project, case=case,
                query_id=q.query_id, s=q.s if isinstance(q.s, str) else list(q.s),
                mode=q.mode, wave=q.wave, origin=q.origin,
                hact=h_costs, flat=f_costs,
                equal_semantics=dig_h == dig_f,
                hact_digest=dig_h, flat_digest=dig_f,
                hact_arrival=_arrival_seconds(h_costs, archived_completion,
                                              simulated=False),
                flat_arrival=_arrival_seconds(f_costs, archived_completion,
                                              simulated=False),
            )
            rows.append(row)
    return rows


# --------------------------------------------------------------------------
# Decision rule (contract section 9, frozen) + summaries
# --------------------------------------------------------------------------

def _maintenance_bytes(costs: QueryCosts) -> int:
    return (costs.index_build_bytes + costs.index_maintenance_bytes
            + costs.storage_bytes)


def decision_table(rows: Sequence[StudyRow]) -> list[dict]:
    """Apply the frozen decision rule per query family.

    HACT is beneficial for a family iff (at equal completeness):
      complete-answer bytes AND complete-answer arrival time improve
    against the indexed flat ledger, maintenance included. Everything is
    reported, including losses.
    """
    families: dict[str, list[StudyRow]] = {}
    for r in rows:
        families.setdefault(r.query_id, []).append(r)

    table = []
    for qid in sorted(families):
        fam = families[qid]
        equal = all(r.equal_semantics for r in fam)
        bytes_pairs = []
        time_pairs = []
        for r in fam:
            h_bytes = r.hact.complete_answer_bytes + _maintenance_bytes(r.hact)
            f_bytes = r.flat.complete_answer_bytes + _maintenance_bytes(r.flat)
            bytes_pairs.append((h_bytes, f_bytes))
            if not (r.hact_arrival["simulated"] or r.flat_arrival["simulated"]):
                h_time = r.hact_arrival["total_seconds"]
                f_time = r.flat_arrival["total_seconds"]
                time_pairs.append((h_time, f_time))
        h_bytes_total = sum(h for h, _ in bytes_pairs)
        f_bytes_total = sum(f for _, f in bytes_pairs)
        bytes_better = h_bytes_total < f_bytes_total
        if time_pairs:
            h_time_total = sum(h for h, _ in time_pairs)
            f_time_total = sum(f for _, f in time_pairs)
            time_better = h_time_total < f_time_total
        else:
            h_time_total = f_time_total = None
            time_better = None
        beneficial = (equal and bytes_better
                      and (time_better is True))
        table.append({
            "query_family": qid,
            "n_queries": len(fam),
            "equal_semantics_all": equal,
            "hact_bytes_with_maintenance": h_bytes_total,
            "flat_bytes_with_maintenance": f_bytes_total,
            "hact_arrival_seconds_total": h_time_total,
            "flat_arrival_seconds_total": f_time_total,
            "bytes_better": bytes_better,
            "time_better": time_better,
            "hact_beneficial": beneficial,
            "note": ("bytes-only decision: no archived timing support"
                     if time_better is None else
                     ("beneficial: both bytes and time improve" if beneficial
                      else "not beneficial under the frozen rule")),
        })
    return table


def amdahl_from_rows(rows: Sequence[StudyRow]) -> dict:
    """Measured Amdahl decomposition (review section 7).

    f = (flat aggregation CPU seconds) / (flat total arrival seconds), i.e.
    the measured fraction of total diagnostic time spent in the path the
    hierarchy optimizes (per-check on-demand aggregation); s = flat CPU /
    hact CPU; ceiling = 1 / ((1-f) + f/s). Measured, never assumed.
    """
    f_cpu = sum(r.flat_arrival["aggregation_cpu_seconds"] for r in rows)
    h_cpu = sum(r.hact_arrival["aggregation_cpu_seconds"] for r in rows)
    f_total = sum(r.flat_arrival["total_seconds"] for r in rows)
    h_total = sum(r.hact_arrival["total_seconds"] for r in rows)
    f = (f_cpu / f_total) if f_total > 0 else 0.0
    s = (f_cpu / h_cpu) if h_cpu > 0 else float("inf")
    ceiling = (1.0 / ((1.0 - f) + f / s)) if s > 0 else float("inf")
    return {
        "f_measured": f,
        "s_measured": s,
        "speedup_ceiling": ceiling,
        "flat_cpu_seconds": f_cpu,
        "hact_cpu_seconds": h_cpu,
        "flat_total_seconds": f_total,
        "hact_total_seconds": h_total,
        "declared_link_bytes_per_second": LINK_BYTES_PER_SECOND,
        "note": ("f is the measured fraction of flat-side total arrival time "
                 "spent in aggregation CPU; s is flat CPU over HACT CPU; the "
                 "ceiling 1/((1-f)+f/s) uses these measured values only."),
    }


def summarize(rows: Sequence[StudyRow]) -> dict:
    """Aggregate per-representation totals over the whole workload."""
    def total(costs: Sequence[QueryCosts]) -> dict:
        keys = ("complete_answer_bytes", "compressed_answer_bytes",
                "round_trips", "pages", "aggregation_cpu_calls",
                "aggregation_bytes_scanned", "aggregation_seconds",
                "index_build_bytes", "index_maintenance_bytes",
                "storage_bytes", "index_build_seconds",
                "index_maintenance_seconds", "cache_hits", "cache_misses",
                "failure_disclosures")
        out = {k: sum(getattr(c, k) for c in costs) for k in keys}
        out["maintenance_bytes"] = sum(_maintenance_bytes(c) for c in costs)
        return out

    return {
        "hact": total([r.hact for r in rows]),
        "indexed_flat": total([r.flat for r in rows]),
        "equal_semantics_all": all(r.equal_semantics for r in rows),
        "n_rows": len(rows),
    }


# --------------------------------------------------------------------------
# Report
# --------------------------------------------------------------------------

def study_report() -> dict:
    """Full P0-3 study report (deterministic; RNG seeded)."""
    rows = run_study()
    return {
        "schema": "v8-real-query-cost-study-1",
        "contract": "docs/V8_SERVICE_CONTRACT.md#7,#9",
        "workload_seed": WORKLOAD_SEED,
        "link_bytes_per_second": LINK_BYTES_PER_SECOND,
        "decision_rule": ("HACT beneficial per family iff complete-answer "
                          "bytes AND arrival time improve vs indexed flat "
                          "ledger, maintenance included, at equal semantics"),
        "workload": {
            "%s/%s" % pc: [
                {"query_id": q.query_id, "s": q.s, "mode": q.mode,
                 "wave": q.wave, "origin": q.origin}
                for q in queries]
            for pc, queries in study_workload().items()
        },
        "rows": [r.as_dict() for r in rows],
        "decision_table": decision_table(rows),
        "amdahl": amdahl_from_rows(rows),
        "summary": summarize(rows),
    }


def main(argv: Sequence[str] | None = None) -> int:
    argv = list(argv or [])
    out = Path(argv[0]) if argv else ROOT / "results" / "v8" / "real_query_cost_study.json"
    report = study_report()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    s = report["summary"]
    print(f"rows={s['n_rows']} equal_semantics_all={s['equal_semantics_all']}")
    for entry in report["decision_table"]:
        print(f"{entry['query_family']}: beneficial={entry['hact_beneficial']} "
              f"bytes_better={entry['bytes_better']} "
              f"time_better={entry['time_better']} "
              f"({entry['note']})")
    a = report["amdahl"]
    print(f"amdahl: f={a['f_measured']:.6f} s={a['s_measured']:.4f} "
          f"ceiling={a['speedup_ceiling']:.4f}")
    print(f"artifact: {out}")
    ok = all(entry["equal_semantics_all"] for entry in report["decision_table"])
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
