"""Frozen, separate v12 observer-cost ablation; never rewrites v11 data.

Only serialization for build/maintenance/storage/scan byte observation is
removed. Functional serialization, copies, kernel packets and answer codecs
remain. Disabled byte counters are emitted as null, never measured zeros.
"""
from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import replace
from datetime import datetime, timezone
import gc
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import platform
import random
import signal
import statistics
import sys
import time
import zlib

from experiments_v8 import service_baselines as old, service_core as core
from experiments_v11.counter_ledger import CounterLedger
from experiments_v11 import service_study as original
from hact.certificates import Evidence, Gate, Kernel, canonical, digest
from ichact.practical import balanced_layout

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'results/v11/public_compiler/SERVICE_CASES.json'
PROTOCOL = ROOT / 'docs/V12_SERVICE_ABLATION_PROTOCOL.md'
OUTPUT = ROOT / 'results/v12/service_ablation'
SEED, REPEATS = 20261022, 3
ARMS = tuple(f'{base}:{state}' for base in
             ('indexed', 'counter', 'hact_original', 'hact_selected')
             for state in ('instrumented', 'observer_disabled'))
BYTE_COUNTERS = ('index_build_bytes', 'index_maintenance_bytes',
                 'storage_bytes', 'aggregation_bytes_scanned')


class ObserverDisabledLedger(old.IndexedFlatLedger):
    def _build(self):
        started = old._now()
        self._index = {cid: None for cid in self.trajectory.registry}
        self._ledger, self._executed = [], []
        self._cache.clear()
        self.costs.index_build_seconds += old._now() - started

    def _ingest(self, snapshot):
        started = old._now()
        for cid in snapshot.executed[len(self._ledger):]:
            rec = json.loads(json.dumps(snapshot.records[cid]))
            event = {'id': cid, **rec, 'wave': len(self._ledger) // core.DEFAULT_WAVE_SIZE}
            self._index[cid] = len(self._ledger)
            self._ledger.append(event)
            self._executed.append(cid)
        self.costs.index_maintenance_seconds += old._now() - started

    def record_of(self, check_id):
        if check_id not in self._index:
            raise ValueError('missing semantic index entry')
        position = self._index[check_id]
        if position is None:
            return None
        if not 0 <= position < len(self._ledger) or self._ledger[position]['id'] != check_id:
            raise ValueError('corrupt ledger index')
        row = self._ledger[position]
        self.costs.aggregation_cpu_calls += 1
        return row


class ObserverDisabledCounter(CounterLedger):
    record_of = ObserverDisabledLedger.record_of

    def _build(self):
        ObserverDisabledLedger._build(self)
        started = time.perf_counter()
        registry = self.trajectory.registry
        self._group_members = {
            'all': registry,
            'unit': tuple(cid for cid in registry if core.predicate_unit(cid)),
            'integration': tuple(cid for cid in registry if core.predicate_integration(cid)),
        }
        self._member_group = {cid: ('unit' if core.predicate_unit(cid) else 'integration')
                              for cid in registry}
        self._group_counts = {name: {'PASS': 0, 'FAIL': 0, 'UNKNOWN': len(members)}
                              for name, members in self._group_members.items()}
        self._counter_group = {members: name for name, members in self._group_members.items()}
        self.counter_updates = 0
        self.costs.index_build_seconds += time.perf_counter() - started

    def _ingest(self, snapshot):
        previous = len(self._ledger)
        ObserverDisabledLedger._ingest(self, snapshot)
        started = time.perf_counter()
        for event in self._ledger[previous:]:
            status = event['status']
            if status not in core.STATUS_ORDER:
                raise ValueError('invalid canonical status')
            for group in ('all', self._member_group[event['id']]):
                self._group_counts[group]['UNKNOWN'] -= 1
                self._group_counts[group][status] += 1
            self.counter_updates += 1
        self.costs.index_maintenance_seconds += time.perf_counter() - started

    def _counts(self, selected):
        group = self._counter_group.get(tuple(selected))
        if group is None:
            return old.IndexedFlatLedger._counts(self, selected)
        counts = dict(self._group_counts[group])
        self.costs.aggregation_cpu_calls += 1
        return counts


class ObserverDisabledHact(old.HactService):
    def _build(self):
        started = old._now()
        ordered = [self.trajectory.registry[i] for i in self.layout.order]
        self._positions = {cid: i for i, cid in enumerate(ordered)}
        self._kernel = Kernel([Gate(cid, ('identity',)) for cid in ordered],
                              {'identity': digest(self.trajectory.identity)}, self.layout.model)
        self._records, self._capsules, self._executed = {}, {}, []
        self._cache.clear()
        self._root = None
        self._packet_count = 0
        self._tree_id = digest(self.layout.tree.to_dict())
        self.costs.index_build_seconds += old._now() - started

    def _ingest(self, snapshot):
        started = old._now()
        for cid in snapshot.executed[len(self._executed):]:
            rec = json.loads(json.dumps(snapshot.records[cid]))
            position = self._positions[cid]
            evidence = Evidence(self._kernel.gate_binding(position), rec['status'], digest(rec))
            self._kernel.submit_trusted(position, evidence)
            self._records[cid] = rec
            self._executed.append(cid)
        self._root, packets = self._kernel.refresh(self.layout.tree)
        self._packet_count = len(packets)
        self._capsules = {(node.lo, node.hi): self._kernel._cache[
            (self._tree_id, node.lo, node.hi)][1] for node in self.layout.tree.walk()}
        self.costs.index_maintenance_seconds += old._now() - started

    def record_of(self, check_id):
        if check_id not in self._positions:
            raise ValueError('missing semantic index entry')
        record = self._records.get(check_id)
        if record is not None:
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
            else:
                for child in node.children:
                    visit(child)
        visit(self.layout.tree)
        return dict(zip(core.STATUS_ORDER, counts))


def make_service(trajectory, layout, arm):
    base, state = arm.split(':')
    disabled = state == 'observer_disabled'
    if arm not in ARMS:
        raise ValueError('unknown arm')
    if base == 'indexed':
        return (ObserverDisabledLedger if disabled else old.IndexedFlatLedger)(trajectory)
    if base == 'counter':
        return (ObserverDisabledCounter if disabled else CounterLedger)(trajectory)
    selected = layout if base == 'hact_selected' else balanced_layout(trajectory.registry)
    return (ObserverDisabledHact if disabled else old.HactService)(trajectory, selected)


def answer_signature(answer, snap, query):
    expected = original.reference_answer(snap, query)
    if answer.semantic != expected:
        raise ValueError('raw-record oracle mismatch')
    # Reconstruct independent expected wire outside service timing. Services
    # themselves still perform the full actual codec and round-trip inside it.
    pages = core.pack_answers(expected, snap.trajectory.identity, query['query_id'],
                              snap.epoch, math.ceil(len(snap.trajectory.evidence['executed']) /
                                                    core.DEFAULT_WAVE_SIZE))
    compressed = zlib.compress(b''.join(pages), 6)
    if (answer.total_pages != len(pages) or
            answer.extras['compressed'] != {'raw_bytes': sum(map(len, pages)),
                                            'answer_zlib_bytes': len(compressed)}):
        raise ValueError('oracle/common wire codec mismatch')
    if 'kernel_counts' in answer.extras:
        counts = core.answer_status(snap, list(snap.registry))['counts']
        if answer.extras['kernel_counts'] != [counts[k] for k in core.STATUS_ORDER]:
            raise ValueError('kernel/oracle counts mismatch')
    return {'semantic_sha256': hashlib.sha256(canonical(expected)).hexdigest(),
            'raw_bytes': sum(map(len, pages)), 'wire_bytes': len(compressed),
            'oracle_wire_sha256': hashlib.sha256(compressed).hexdigest(), 'pages': len(pages)}


def run_arm(trajectory, layout, arm):
    started = time.perf_counter()
    service = make_service(trajectory, layout, arm)
    build_seconds = time.perf_counter() - started
    operations = [{'operation': 'build', 'seconds': build_seconds}]
    total_waves = math.ceil(len(trajectory.evidence['executed']) / core.DEFAULT_WAVE_SIZE)
    request_epochs = {0, max(1, total_waves // 2), total_waves}
    rows = []
    for epoch in range(total_waves + 1):
        if time.perf_counter() - started > 180:
            raise TimeoutError('per-arm 180 second deadline')
        snap = original.snapshot(trajectory, epoch)
        tick = time.perf_counter()
        service._sync(snap)
        operations.append({'operation': 'ingest', 'epoch': epoch,
                           'seconds': time.perf_counter() - tick})
        if epoch not in request_epochs:
            continue
        for query in old.frozen_queries():
            # Match v11: independent oracle preparation outside service timers.
            original.reference_answer(snap, query)
            for phase in ('cold', 'warm'):
                tick = time.perf_counter()
                answer = service.query(query['query_id'], snap, query['s'], query['mode'],
                                       wave=query.get('wave'))
                elapsed = time.perf_counter() - tick
                signature = answer_signature(answer, snap, query)
                rows.append({'epoch': epoch, 'query': query['query_id'], 'phase': phase,
                             'seconds': elapsed, **signature})
                operations.append({'operation': 'query', 'epoch': epoch,
                                   'query': query['query_id'], 'phase': phase, 'seconds': elapsed})
    costs = service.costs.as_dict()
    if arm.endswith(':observer_disabled'):
        for key in BYTE_COUNTERS:
            if costs[key] != 0:
                raise ValueError('disabled observational byte counter unexpectedly updated')
            costs[key] = None
    return {'arm': arm, 'status': 'PASS', 'build_seconds': build_seconds,
            'service_operation_seconds': sum(row['seconds'] for row in operations),
            'query_seconds': sum(row['seconds'] for row in rows),
            'operations': operations, 'queries': rows, 'costs': costs,
            'input_preparation_and_oracle_seconds_excluded': True}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, sort_keys=True, indent=2) + '\n')
    temporary.replace(path)


def runtime_inventory():
    # Preserve all discovery records rather than collapsing duplicate names.
    distributions = []
    for dist in importlib.metadata.distributions():
        metadata = dist.read_text('METADATA') or dist.read_text('PKG-INFO') or ''
        distributions.append({'name': dist.metadata.get('Name'), 'version': dist.version,
            'metadata_path': str(getattr(dist, '_path', '')),
            'metadata_sha256': hashlib.sha256(metadata.encode()).hexdigest()})
    distributions.sort(key=lambda row: (row['name'] or '', row['version'], row['metadata_path']))
    multiplicity = Counter((row['name'] or '').lower().replace('_', '-') for row in distributions)
    return {'python': sys.version, 'executable': sys.executable,
            'python_executable_sha256': sha(sys.executable), 'platform': platform.platform(),
            'sys_path': sys.path, 'prefix': sys.prefix, 'base_prefix': sys.base_prefix,
            'cpu_count': os.cpu_count(), 'cpu_affinity': sorted(os.sched_getaffinity(0)),
            'cpuinfo': Path('/proc/cpuinfo').read_text(),
            'memory': Path('/proc/meminfo').read_text(), 'load_average': os.getloadavg(),
            'gc_enabled': gc.isenabled(), 'gc_threshold': gc.get_threshold(),
            'perf_counter': str(time.get_clock_info('perf_counter')),
            'distributions': distributions,
            'duplicate_distribution_names': {name: n for name, n in multiplicity.items() if n > 1}}


def freeze(output=OUTPUT):
    path = output / 'FROZEN_INPUTS.json'
    if path.exists():
        raise ValueError('refuse to overwrite frozen campaign identity')
    cases = json.loads(MANIFEST.read_text())
    files = {MANIFEST, PROTOCOL, Path(__file__), ROOT / 'tests_v12/test_observer_ablation.py'}
    files.update(core.CORPUS_ROOT / 'toolz/toolz_confirm_009-fixed8' / name
                 for name in ('pytest_evidence.json', 'report.json'))
    for case in cases:
        files.update(ROOT / case[name] for name in ('evidence', 'report', 'layout'))
    for directory in ('hact', 'ichact', 'experiments_v8', 'experiments_v11'):
        files.update((ROOT / directory).rglob('*.py'))
    schedule, rng = [], random.Random(SEED)
    for case in cases:
        trajectory, _ = original.load_case(case)
        if trajectory.n <= original.MAX_SERVICE_REGISTRY:
            for repeat in range(REPEATS):
                arms = list(ARMS)
                rng.shuffle(arms)
                schedule.append({'case': case['case'], 'repetition': repeat, 'arm_order': arms})
    result = {'schema': 'hact-v12-observer-ablation-freeze-1',
              'frozen_utc': datetime.now(timezone.utc).isoformat(), 'seed': SEED,
              'repeats': REPEATS, 'case_manifest': str(MANIFEST.relative_to(ROOT)),
              'hashes': {str(p.relative_to(ROOT)): sha(p) for p in sorted(files)},
              'runtime': runtime_inventory(), 'schedule': schedule,
              'timing_boundary': 'build + every ingest + cold/warm query; oracle excluded',
              'limits': {'arm_seconds': 180, 'campaign_seconds': 900, 'retained_bytes': 52428800}}
    write_json(path, result)
    return result


def validate_freeze(output=OUTPUT):
    path = output / 'FROZEN_INPUTS.json'
    frozen = json.loads(path.read_text())
    for name, expected in frozen['hashes'].items():
        if sha(ROOT / name) != expected:
            raise ValueError('frozen input/code changed: ' + name)
    return frozen


def preflight():
    # Small real failure/partial trace tests all arms through full -> rewind ->
    # partial epochs. No timings from this correctness fixture are reported.
    trajectory = core.Trajectory.load('toolz', 'toolz_confirm_009')
    layout = balanced_layout(trajectory.registry)
    checks = 0
    for arm in ARMS:
        service = make_service(trajectory, layout, arm)
        for epoch in (math.ceil(len(trajectory.evidence['executed']) / 8), 0, 1):
            snap = original.snapshot(trajectory, epoch)
            for query in old.frozen_queries():
                answer = service.query(query['query_id'], snap, query['s'], query['mode'],
                                       wave=query.get('wave'))
                answer_signature(answer, snap, query)
                checks += 1
        foreign = replace(trajectory, report={**trajectory.report, 'snapshot': 'foreign-v12'})
        try:
            service._sync(original.snapshot(foreign, 1))
        except ValueError as exc:
            if 'foreign' not in str(exc):
                raise
        else:
            raise ValueError('foreign snapshot accepted')
    return {'status': 'PASS', 'oracle_wire_checks': checks,
            'arms': len(ARMS), 'rewind_and_foreign_snapshot': 'PASS'}


def summarize(report):
    result = {'schema': 'hact-v12-observer-ablation-summary-1',
              'interpretation': 'descriptive follow-up on instrumented prototypes; no significance or production-speed inference',
              'cases': [], 'excluded': [], 'all_selected_hact_slower': {s: True for s in
                  ('instrumented', 'observer_disabled')}}
    for case in report['cases']:
        if case['status'] != 'PASS':
            result['excluded'].append({'case': case['case'], 'status': case['status'],
                                       'reason': case.get('reason')})
            continue
        values = {arm: [] for arm in ARMS}
        for repeat in case['repetitions']:
            if set(repeat['arm_order']) != set(ARMS) or len(repeat['executions']) != len(ARMS):
                raise ValueError('incomplete paired arms')
            if [row['arm'] for row in repeat['executions']] != repeat['arm_order']:
                raise ValueError('execution identities/order differ from paired schedule')
            for execution in repeat['executions']:
                if execution['status'] != 'PASS':
                    raise ValueError('cannot summarize nonpassing arm')
                values[execution['arm']].append(execution['service_operation_seconds'])
        if any(len(v) != REPEATS for v in values.values()):
            raise ValueError('incomplete paired repetitions')
        medians = {arm: statistics.median(v) for arm, v in values.items()}
        states = {}
        for state in ('instrumented', 'observer_disabled'):
            ratios = [h / c for h, c in zip(values['hact_selected:' + state],
                                             values['counter:' + state])]
            states[state] = {'paired_ratios': ratios, 'min': min(ratios), 'max': max(ratios),
                'median_paired_ratio': statistics.median(ratios),
                'ratio_of_arm_medians': medians['hact_selected:' + state] / medians['counter:' + state]}
            result['all_selected_hact_slower'][state] &= all(ratio > 1 for ratio in ratios)
        result['cases'].append({'case': case['case'], 'project': case['project'],
                               'median_operation_seconds': medians, 'selected_hact_vs_counter': states})
    return result


def campaign(output=OUTPUT):
    frozen = validate_freeze(output)
    if (output / 'raw.json').exists():
        raise ValueError('refuse to overwrite observed campaign')
    started = time.monotonic()
    report = {'schema': 'hact-v12-observer-ablation-1', 'status': 'RUNNING',
              'freeze_sha256': sha(output / 'FROZEN_INPUTS.json'),
              'started_utc': datetime.now(timezone.utc).isoformat(), 'preflight': preflight(),
              'cases': [], 'inference_unit': 'project; timing repeats are paired descriptive blocks'}
    write_json(output / 'raw.json', report)
    schedule = {(r['case'], r['repetition']): r['arm_order'] for r in frozen['schedule']}
    def timeout(_signum, _frame):
        raise TimeoutError('declared per-arm or remaining campaign deadline')
    previous_handler = signal.signal(signal.SIGALRM, timeout)
    try:
        for case in json.loads(MANIFEST.read_text()):
            trajectory, layout = original.load_case(case)
            entry = {**case, 'n': trajectory.n, 'status': 'PASS', 'repetitions': []}
            report['cases'].append(entry)
            if trajectory.n > original.MAX_SERVICE_REGISTRY:
                entry.update(status='UNKNOWN', reason='frozen complete-registry service admission >2048; no imputation')
                write_json(output / 'raw.json', report)
                continue
            reference_signature = None
            for repetition in range(REPEATS):
                arms = schedule[(case['case'], repetition)]
                block = {'repetition': repetition, 'arm_order': arms, 'executions': []}
                entry['repetitions'].append(block)
                for arm in arms:
                    remaining = 900 - (time.monotonic() - started)
                    if remaining <= 0:
                        raise TimeoutError('declared 900 second campaign budget exceeded')
                    signal.setitimer(signal.ITIMER_REAL, min(180, remaining))
                    try:
                        execution = run_arm(trajectory, layout, arm)
                    except Exception as exc:
                        execution = {'arm': arm, 'status': 'UNKNOWN' if isinstance(exc, TimeoutError) else 'FAIL',
                                     'reason': f'{type(exc).__name__}: {exc}'}
                        block['executions'].append(execution)
                        entry.update(status=execution['status'], reason=execution['reason'])
                        raise
                    finally:
                        signal.setitimer(signal.ITIMER_REAL, 0)
                    signature = [{k: v for k, v in q.items() if k != 'seconds'} for q in execution['queries']]
                    if reference_signature is not None and signature != reference_signature:
                        raise ValueError('cross-arm/repetition semantic or wire conformance failure')
                    reference_signature = signature
                    block['executions'].append(execution)
                    write_json(output / 'raw.json', report)
                print(json.dumps({'case': case['case'], 'repeat': repetition, 'status': 'PASS'}), flush=True)
            if sum(p.stat().st_size for p in output.rglob('*') if p.is_file()) > 52428800:
                raise ValueError('retained-data limit exceeded')
        validate_freeze(output)
        report['status'] = 'UNKNOWN' if any(c['status'] == 'UNKNOWN' for c in report['cases']) else 'PASS'
        report['admitted_status'] = 'PASS'
    except Exception as exc:
        report['status'] = 'UNKNOWN' if isinstance(exc, TimeoutError) else 'FAIL'
        report['failure'] = f'{type(exc).__name__}: {exc}'
        raise
    finally:
        signal.signal(signal.SIGALRM, previous_handler)
        report['elapsed_wall_seconds'] = time.monotonic() - started
        report['finished_utc'] = datetime.now(timezone.utc).isoformat()
        write_json(output / 'raw.json', report)
    write_json(output / 'SUMMARY.json', summarize(report))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('preflight', 'freeze', 'run', 'check'))
    parser.add_argument('--output', type=Path, default=OUTPUT)
    args = parser.parse_args()
    if args.action == 'preflight':
        result = preflight()
    elif args.action == 'freeze':
        frozen = freeze(args.output)
        result = {'status': 'FROZEN', 'hashes': len(frozen['hashes']), 'timing_blocks': len(frozen['schedule'])}
    elif args.action == 'run':
        report = campaign(args.output)
        result = {'status': report['status'], 'admitted_status': report.get('admitted_status'),
                  'wall_seconds': report['elapsed_wall_seconds']}
    else:
        validate_freeze(args.output)
        raw = json.loads((args.output / 'raw.json').read_text())
        if summarize(raw) != json.loads((args.output / 'SUMMARY.json').read_text()):
            raise ValueError('summary projection mismatch')
        result = {'status': 'PASS', 'frozen_inputs_and_summary': 'verified'}
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
