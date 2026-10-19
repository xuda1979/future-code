"""Corrected v9 diagnostic microbenchmark; the historical v8 JSON is retained.

Per-query wire bytes and host elapsed times are separate from setup work and
canonical serialized storage. Both original and learned trees are evaluated;
all Q1--Q6 queries are issued twice (cold query cache, then warm). Common
archived checker time and a declared 1 MiB/s link produce arithmetic arrival
estimates only. Setup is allocated uniformly within each complete query trace,
independent of query ordering. No network, live-agent or CPU-cycle claim.
"""
from __future__ import annotations

import json
import random
import sys
from dataclasses import dataclass
from pathlib import Path

from experiments_v8 import service_baselines as sb, service_core as core
from experiments_v8.service_oracle import learned_order

ROOT = Path(__file__).resolve().parent.parent
LINK_BYTES_PER_SECOND = 1_048_576
WORKLOAD_SEED = 20261009


@dataclass(frozen=True)
class WorkloadQuery:
    query_id: str
    s: object
    mode: str
    wave: int | None = None
    origin: str = 'frozen-v8-plus-explicit-v9-Q3'


def failing_cases():
    return [(project, case) for project, case in core.CORPUS
            if any(r['status'] == 'FAIL' for r in
                   core.Trajectory.load(project, case).evidence['records'].values())]


def study_workload():
    rng = random.Random(WORKLOAD_SEED)
    failing = set(failing_cases())
    workload = {}
    for project, case in core.CORPUS:
        t = core.Trajectory.load(project, case)
        total = (len(t.evidence['executed']) + t.wave_size() - 1) // t.wave_size()
        queries = [WorkloadQuery('Q1', 'all', 'status'),
                   WorkloadQuery('Q3', 'unfinished', 'status'),
                   WorkloadQuery('Q4', 'all', 'coverage_proof'),
                   WorkloadQuery('Q6a', 'unit', 'status'),
                   WorkloadQuery('Q6b', 'integration', 'status'),
                   WorkloadQuery('Q5', 'all', 'replay', 0)]
        if (project, case) in failing:
            queries.append(WorkloadQuery('Q2', 'failing', 'failure_localization'))
        if total > 1:
            for wave in sorted(rng.sample(range(1, total), min(2, total - 1))):
                queries.append(WorkloadQuery('Q5', 'all', 'replay', wave,
                                              'derived:seeded-replay'))
        workload[(project, case)] = queries
    return workload


@dataclass
class QueryCosts:
    representation: str
    complete_answer_bytes: int = 0
    compressed_answer_bytes: int = 0
    pages: int = 0
    round_trips: int = 0
    aggregation_cpu_calls: int = 0  # instrumented record/capsule reads, not instructions
    aggregation_bytes_scanned: int = 0
    aggregation_seconds: float = 0.0
    encode_seconds: float = 0.0
    decode_seconds: float = 0.0
    cache_hits: int = 0
    cache_misses: int = 0
    failure_disclosures: int = 0

    def as_dict(self):
        return dict(self.__dict__)


def _measure_arm(service, snapshot, query, costs):
    before = service.costs.as_dict()
    answer = service.query(query.query_id, snapshot, query.s, query.mode, wave=query.wave)
    after = service.costs.as_dict()
    for name in costs.__dict__:
        if name in after:
            setattr(costs, name, after[name] - before[name])
    costs.complete_answer_bytes = answer.extras['compressed']['raw_bytes']
    costs.compressed_answer_bytes = answer.extras['compressed']['answer_zlib_bytes']
    return answer


def _archived_wave_completion_times(trajectory):
    elapsed, times = 0.0, []
    executed = trajectory.evidence['executed']
    for offset in range(0, len(executed), trajectory.wave_size()):
        elapsed += sum(trajectory.evidence['records'][cid].get('wall_seconds', 0.0)
                       for cid in executed[offset:offset + trajectory.wave_size()])
        times.append(elapsed)
    return times


def _arrival_seconds(costs, archived_completion, setup_share):
    processing = costs.aggregation_seconds + costs.encode_seconds + costs.decode_seconds
    transfer = costs.compressed_answer_bytes / LINK_BYTES_PER_SECOND
    return {'archived_completion_seconds': archived_completion,
            'aggregation_cpu_seconds': costs.aggregation_seconds,  # legacy label; host elapsed
            'query_processing_seconds': processing,
            'allocated_setup_seconds': setup_share,
            'transfer_seconds_at_declared_rate': transfer,
            'link_bytes_per_second': LINK_BYTES_PER_SECOND,
            'total_seconds': archived_completion + setup_share + processing + transfer,
            'simulated': True,
            'kind': 'arithmetic serial critical-path model; not measured arrival'}


@dataclass
class StudyRow:
    project: str
    case: str
    query_id: str
    s: str
    mode: str
    wave: int | None
    origin: str
    layout: str
    cache_phase: str
    setup_id: str
    hact: QueryCosts
    flat: QueryCosts
    equal_semantics: bool
    hact_digest: str
    flat_digest: str
    hact_arrival: dict
    flat_arrival: dict

    def as_dict(self):
        return {k: v.as_dict() if isinstance(v, QueryCosts) else v
                for k, v in self.__dict__.items()}


def _run_study():
    rows, setups = [], []
    arm_rng = random.Random(WORKLOAD_SEED + 9)
    for (project, case), queries in study_workload().items():
        trajectory = core.Trajectory.load(project, case)
        snapshot = trajectory.snapshot()
        times = _archived_wave_completion_times(trajectory)
        for layout_name, order in [('original', None), ('learned', learned_order(trajectory))]:
            if layout_name == 'learned' and order is None:
                raise ValueError('missing learned layout; refuse silent arm substitution')
            hact = sb.HactService(trajectory, sb.build_layout(trajectory, order=order))
            flat = sb.IndexedFlatLedger(trajectory)
            for service in (hact, flat):
                service._sync(snapshot)  # setup before query measurement, not charged to Q1
            setup_id = '%s/%s/%s' % (project, case, layout_name)
            setup = {'id': setup_id, 'query_count': 2 * len(queries),
                     'hact': hact.costs.as_dict(), 'flat': flat.costs.as_dict(),
                     'storage_unit': 'canonical serialized bytes; excludes query-cache copies; not RAM or wire',
                     'update_unit': 'logical serialized updates; not network traffic'}
            setup['flat_whole_ledger_zlib_bytes'] = flat.whole_ledger_zlib_bytes()
            setups.append(setup)
            shares = {arm: (setup[arm]['index_build_seconds'] +
                            setup[arm]['index_maintenance_seconds']) / setup['query_count']
                      for arm in ('hact', 'flat')}
            for query in queries:
                for phase in ('cold', 'warm'):
                    hc, fc = QueryCosts('hact'), QueryCosts('indexed_flat')
                    if arm_rng.getrandbits(1):
                        ah = _measure_arm(hact, snapshot, query, hc)
                        af = _measure_arm(flat, snapshot, query, fc)
                    else:
                        af = _measure_arm(flat, snapshot, query, fc)
                        ah = _measure_arm(hact, snapshot, query, hc)
                    dh, df = core.semantic_digest(ah.semantic), core.semantic_digest(af.semantic)
                    needed = query.wave + 1 if query.mode == 'replay' else len(times)
                    completion = times[needed - 1] if times else 0.0
                    rows.append(StudyRow(project, case, query.query_id, query.s, query.mode,
                        query.wave, query.origin, layout_name, phase, setup_id, hc, fc,
                        dh == df, dh, df, _arrival_seconds(hc, completion, shares['hact']),
                        _arrival_seconds(fc, completion, shares['flat'])))
    return rows, setups


def run_study(include_maintenance=True):
    if not include_maintenance:
        raise ValueError('v9 study always accounts for setup separately')
    return _run_study()[0]


def decision_table(rows):
    table = []
    for qid in sorted({r.query_id for r in rows}):
        family = [r for r in rows if r.query_id == qid]
        hb = sum(r.hact.compressed_answer_bytes for r in family)
        fb = sum(r.flat.compressed_answer_bytes for r in family)
        ht = sum(r.hact_arrival['total_seconds'] for r in family)
        ft = sum(r.flat_arrival['total_seconds'] for r in family)
        equal = all(r.equal_semantics for r in family)
        table.append({'query_family': qid, 'n_queries': len(family),
                      'equal_semantics_all': equal,
                      'hact_wire_bytes': hb, 'flat_wire_bytes': fb,
                      'hact_modeled_arrival_seconds_total': ht,
                      'flat_modeled_arrival_seconds_total': ft,
                      'bytes_better': hb < fb, 'time_better': ht < ft,
                      'hact_beneficial': equal and hb < fb and ht < ft,
                      'note': 'strict byte-and-modeled-time rule; byte equality follows from common codec'})
    return table


def amdahl_from_rows(rows):
    flat_cpu = sum(r.flat.aggregation_seconds for r in rows)
    hact_cpu = sum(r.hact.aggregation_seconds for r in rows)
    total = sum(r.flat_arrival['total_seconds'] for r in rows)
    fraction = flat_cpu / total if total else 0.0
    ratio = flat_cpu / hact_cpu if hact_cpu else float('inf')
    return {'f_measured': fraction, 's_measured': ratio,
            'flat_cpu_seconds': flat_cpu, 'hact_cpu_seconds': hact_cpu,
            'flat_total_seconds': total,
            'hact_total_seconds': sum(r.hact_arrival['total_seconds'] for r in rows),
            'predicted_speedup_at_observed_ratio': 1 / (1 - fraction + fraction / ratio),
            'unbounded_aggregation_speedup_ceiling': 1 / (1 - fraction),
            'maximum_latency_reduction_percent': 100 * fraction,
            'boundary': 'fraction of modeled arrival; aggregation_seconds measures host elapsed time'}


def summarize(rows):
    def total(arm):
        result = {}
        for field in QueryCosts(arm).__dict__:
            if field != 'representation':
                result[field] = sum(getattr(getattr(r, arm), field) for r in rows)
        return result
    return {'hact': total('hact'), 'indexed_flat': total('flat'),
            'n_rows': len(rows), 'equal_semantics_all': all(r.equal_semantics for r in rows)}


def study_report():
    rows, setups = _run_study()
    return {'schema': 'v9-real-query-cost-study-1',
            'contract': 'docs/V9_CORRECTION_CONTRACT.md',
            'workload_seed': WORKLOAD_SEED,
            'arm_order_seed': WORKLOAD_SEED + 9,
            'inputs': core.corpus_provenance(),
            'link_bytes_per_second': LINK_BYTES_PER_SECOND,
            'decision_rule': 'equal semantics AND strictly smaller compressed answer bytes AND lower modeled arrival; setup allocated uniformly per trace',
            'timing_provenance': {'kind': 'single local retrospective microbenchmark',
                                  'repeated_timing_trials': 1,
                                  'inference': 'descriptive; no statistical latency or WAN conclusion'},
            'setups': setups, 'rows': [r.as_dict() for r in rows],
            'decision_table': decision_table(rows), 'amdahl': amdahl_from_rows(rows),
            'summary': summarize(rows)}


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    destination = Path(args[0]) if args else ROOT / 'results/v9/real_query_cost_study.json'
    if destination.exists():
        raise FileExistsError('refuse to overwrite recorded evidence; choose a new output path')
    report = study_report()
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, indent=2, sort_keys=True) + '\n')
    print(json.dumps({'rows': report['summary']['n_rows'],
                      'equal': report['summary']['equal_semantics_all'],
                      'families': report['decision_table']}, indent=2))
    return 0 if report['summary']['equal_semantics_all'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
