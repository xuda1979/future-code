"""Whole-trajectory local service comparison with a maintained-counter control.

Inputs are an explicit case list, raw trace/report paths and a selected layout.
Snapshot preparation and the independent answer oracle are outside service
timers. All builds, every eight-completion ingest, cold/warm queries and codec
round trips are inside the measured operation sums. No WAN or RAM estimate.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import platform
import random
import sys
import time
from pathlib import Path

from experiments_v8 import service_core as core, service_baselines as old
from experiments_v11.counter_ledger import CounterLedger
from hact.certificates import canonical
from ichact.layout import Layout
from ichact.practical import balanced_layout

ROOT = Path(__file__).resolve().parents[1]
SEED = 20261021
REPEATS = 3
MAX_SERVICE_REGISTRY = 2048


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_case(case):
    evidence_path, report_path = (ROOT / case[name] for name in ('evidence', 'report'))
    evidence = json.loads(evidence_path.read_text())
    report = json.loads(report_path.read_text())
    registry, executed = tuple(evidence['registry']), evidence['executed']
    if not registry or len(set(registry)) != len(registry):
        raise ValueError('nonempty unique declared registry required')
    if len(set(executed)) != len(executed) or not set(executed) <= set(registry):
        raise ValueError('duplicate or foreign completed obligation')
    if set(evidence['records']) != set(executed):
        raise ValueError('records and actual completion IDs must agree')
    if any(r['status'] not in core.STATUS_ORDER for r in evidence['records'].values()):
        raise ValueError('invalid recorded status')
    trajectory = core.Trajectory(case['project'], case['case'], evidence, report, registry)
    selected = Layout.from_dict(json.loads((ROOT / case['layout']).read_text()))
    if selected.registry != registry:
        raise ValueError('selected layout changed the declared registry')
    return trajectory, selected


def snapshot(trajectory, epoch):
    # Input references are immutable during a run. The services independently
    # ingest/copy records. This preparation is common input work, not HACT work.
    completed = tuple(trajectory.evidence['executed'][:epoch * core.DEFAULT_WAVE_SIZE])
    return core.TrajectorySnapshot(trajectory, epoch, completed,
        {cid: trajectory.evidence['records'][cid] for cid in completed})


def reference_answer(snap, query):
    selected = core.select_members(snap, query['s'])
    if query['mode'] == 'replay':
        return core.answer_replay(snap, query['wave'])
    fn = {'status': core.answer_status,
          'coverage_proof': core.answer_coverage_proof,
          'failure_localization': core.answer_failure_localization}[query['mode']]
    return fn(snap, selected)


def run_arm(trajectory, layout, arm, *, deadline_seconds=180):
    factories = {
        'indexed': lambda: old.IndexedFlatLedger(trajectory),
        'counter': lambda: CounterLedger(trajectory),
        'hact_original': lambda: old.HactService(trajectory, balanced_layout(trajectory.registry)),
        'hact_selected': lambda: old.HactService(trajectory, layout),
    }
    started = time.perf_counter()
    service = factories[arm]()
    measured = time.perf_counter() - started
    total_waves = math.ceil(len(trajectory.evidence['executed']) / core.DEFAULT_WAVE_SIZE)
    request_epochs = {0, max(1, total_waves // 2), total_waves}
    queries = old.frozen_queries()
    rows = []
    for epoch in range(total_waves + 1):
        if time.perf_counter() - started > deadline_seconds:
            raise TimeoutError('declared per-arm service deadline exceeded')
        snap = snapshot(trajectory, epoch)
        tick = time.perf_counter()
        service._sync(snap)
        measured += time.perf_counter() - tick
        if epoch not in request_epochs:
            continue
        for query in queries:
            expected = reference_answer(snap, query)
            for phase in ('cold', 'warm'):
                tick = time.perf_counter()
                answer = service.query(query['query_id'], snap, query['s'], query['mode'],
                                       wave=query.get('wave'))
                elapsed = time.perf_counter() - tick
                measured += elapsed
                if answer.semantic != expected:
                    raise ValueError('service/oracle semantic mismatch: %s/%s/%s' %
                                     (trajectory.case, arm, query['query_id']))
                if arm.startswith('hact'):
                    counts = answer.extras['kernel_counts']
                    raw = core.answer_status(snap, list(trajectory.registry))['counts']
                    if counts != [raw[k] for k in core.STATUS_ORDER]:
                        raise ValueError('kernel status disagrees with raw-record oracle')
                rows.append({'epoch': epoch, 'query': query['query_id'], 'phase': phase,
                    'seconds': elapsed, 'semantic_sha256': hashlib.sha256(canonical(expected)).hexdigest(),
                    'raw_bytes': answer.extras['compressed']['raw_bytes'],
                    'wire_bytes': answer.extras['compressed']['answer_zlib_bytes'],
                    'pages': answer.total_pages})
    return {'arm': arm, 'status': 'PASS', 'service_operation_seconds': measured,
            'query_seconds': sum(r['seconds'] for r in rows),
            'costs': service.costs.as_dict(), 'queries': rows,
            'input_preparation_and_oracle_seconds_excluded': True}


def run_study(manifest, output):
    loaded = json.loads(manifest.read_text())
    case_list = loaded if isinstance(loaded, list) else loaded['cases']
    if not case_list:
        raise ValueError('empty cohort cannot pass')
    rng = random.Random(SEED)
    report = {'schema': 'hact-v11-local-service-1', 'status': 'PASS',
        'origin': 'controlled fixed consumer; not observed production demand',
        'seed': SEED, 'repeats': REPEATS, 'host': platform.platform(),
        'python': sys.version, 'input_manifest_sha256': sha(manifest),
        'inference_unit': 'project; process/cache repeats are not independent projects',
        'timing_unit': 'measured local elapsed operation sums; no transport',
        'cases': []}
    for case in case_list:
        trajectory, layout = load_case(case)
        entry = {**case, 'n': trajectory.n,
                 'input_hashes': {name: sha(ROOT / case[name]) for name in ('evidence', 'report', 'layout')},
                 'repetitions': [], 'status': 'PASS'}
        if trajectory.n > MAX_SERVICE_REGISTRY:
            entry.update(status='UNKNOWN', reason='preanalysis service resource admission: '
                         'complete registry exceeds 2048; no rows sampled or imputed')
            report['status'] = 'UNKNOWN'
            report['cases'].append(entry)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(report, indent=2, sort_keys=True) + '\n')
            print(json.dumps({'case': case['case'], 'status': 'UNKNOWN',
                              'reason': entry['reason']}), flush=True)
            continue
        for repetition in range(REPEATS):
            arms = ['indexed', 'counter', 'hact_original', 'hact_selected']
            rng.shuffle(arms)
            executions = []
            for arm in arms:
                try:
                    executions.append(run_arm(trajectory, layout, arm))
                except TimeoutError as exc:
                    executions.append({'arm': arm, 'status': 'UNKNOWN', 'reason': str(exc)})
                    report['status'] = 'UNKNOWN'
                    entry['status'] = 'UNKNOWN'
            successful = [x for x in executions if x['status'] == 'PASS']
            if successful:
                signature = lambda row: [(q['epoch'], q['query'], q['phase'],
                    q['semantic_sha256'], q['raw_bytes'], q['wire_bytes'], q['pages'])
                    for q in row['queries']]
                if any(signature(row) != signature(successful[0]) for row in successful[1:]):
                    raise ValueError('common answer/codec conformance failure')
            entry['repetitions'].append({'repetition': repetition, 'arm_order': arms,
                                        'executions': executions})
        report['cases'].append(entry)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2, sort_keys=True) + '\n')
        print(json.dumps({'case': case['case'], 'n': trajectory.n,
                          'status': report['status']}), flush=True)
    return report


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('manifest', type=Path)
    p.add_argument('output', type=Path)
    args = p.parse_args()
    run_study(args.manifest, args.output)


if __name__ == '__main__':
    main()
