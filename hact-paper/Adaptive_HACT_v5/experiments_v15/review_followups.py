"""Post-review replay, sparse compact compilation and exclusive CPU diagnosis.

No historical observation or endpoint is replaced. Timing diagnostics are
distinct from the frozen unprofiled service comparison.
"""
from __future__ import annotations

import argparse
from collections import Counter
import cProfile
import hashlib
import json
import math
from pathlib import Path
import platform
import pstats
import resource
import subprocess
import sys
import time
import os

from audit.check_v14 import literal_cost
from experiments_v11 import service_study as original
from experiments_v12 import observer_ablation as observer
from ichact.practical import balanced_layout
from ichact.sparse import select_sparse, touched_cost

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'results/v15'
PROJECTS = ('click', 'jinja', 'pluggy', 'attrs', 'exceptiongroup')


def read(path):
    return json.loads((ROOT / path).read_text())


def sha(path):
    return hashlib.sha256((ROOT / path).read_bytes()).hexdigest()


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x') as stream:
        stream.write(json.dumps(data, indent=2, sort_keys=True) + '\n')


def cap64_replay():
    reference = read('results/v14/exchangeable.json')
    rows = []
    for project in PROJECTS:
        parent = ROOT / 'results/v11/public_compiler' / project
        layouts = {name: json.loads((parent / file).read_text()) for name, file in {
            'historical': 'historical_layout.json', 'cap32': 'selected_layout.json',
            'cap64': 'selected_layout_sensitivity.json'}.items()}
        symmetric = next(r for r in reference['public'] if r['project'] == project)
        for item in symmetric['dispatch_shifts']:
            evidence = read(item['input'])
            if any(l['registry'] != evidence['registry'] for l in layouts.values()):
                raise ValueError('dispatch registry mismatch')
            costs = {name: literal_cost(layout, evidence['executed'])
                     for name, layout in layouts.items()}
            if costs['historical'] != item['historical'] or costs['cap32'] != item['fullwave32']:
                raise ValueError('historical dispatch scores changed')
            costs['exchangeable'] = literal_cost(symmetric['layout'], evidence['executed'])
            if costs['exchangeable'] != item['exchangeable']:
                raise ValueError('symmetric retained score changed')
            receipt = read(str(Path(item['input']).with_name('receipt.json')))
            if any(costs[k] != receipt['costs'][k] for k in ('historical', 'cap32', 'cap64')):
                raise ValueError('independent score differs from raw receipt')
            rows.append({'project': project, 'policy': item['policy'], 'seed': item['seed'],
                         'input': item['input'], 'costs': costs})
    if len(rows) != 30:
        raise ValueError('all admitted shifts required')
    return rows


def input_files():
    files = {'docs/V15_REVIEW_PROTOCOL.md', 'experiments_v15/review_followups.py',
             'results/v11/public_compiler/SERVICE_CASES.json', 'results/v14/exchangeable.json'}
    for directory in ('hact', 'ichact', 'experiments_v8', 'experiments_v11', 'experiments_v12'):
        files.update(str(p.relative_to(ROOT)) for p in (ROOT / directory).glob('*.py'))
    cases = read('results/v11/public_compiler/SERVICE_CASES.json')
    for case in cases:
        files.update(case[k] for k in ('evidence', 'report', 'layout'))
    for run in range(5):
        files.add(f'results/v11/public_checks_normalized/packaging/run_{run}/pytest_evidence.json')
    for row in cap64_replay():
        files.add(row['input'])
        files.add(str(Path(row['input']).with_name('receipt.json')))
        for name in ('historical_layout.json', 'selected_layout.json', 'selected_layout_sensitivity.json'):
            files.add(f"results/v11/public_compiler/{row['project']}/{name}")
    return sorted(files)


def freeze():
    record = {'schema': 'hact-v15-freeze-1', 'files': {p: sha(p) for p in input_files()},
              'scope': 'internal pre-execution freeze; not external preregistration',
              'python': platform.python_version(), 'platform': platform.system()}
    write(OUT / 'FREEZE.json', record)
    return record


def verify_freeze():
    data = read('results/v15/FREEZE.json')
    if data['schema'] != 'hact-v15-freeze-1':
        raise ValueError('invalid freeze schema')
    for path, digest in data['files'].items():
        if sha(path) != digest:
            raise ValueError('frozen source/input changed: ' + path)
    return data


def waves(raw, registry):
    if raw['registry'] != list(registry) or len(raw['executed']) != len(registry) or set(raw['executed']) != set(registry):
        raise ValueError('complete unchanged registry required')
    index = {cid: i for i, cid in enumerate(registry)}
    return [[index[cid] for cid in raw['executed'][i:i + 8]]
            for i in range(0, len(registry), 8)]


def sparse_child():
    resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
    verify_freeze()
    base = 'results/v11/public_checks_normalized/packaging'
    raw = [read(f'{base}/run_{i}/pytest_evidence.json') for i in range(3)]
    registry = tuple(raw[0]['registry'])
    started = time.perf_counter()
    selected, info = select_sparse(registry, [waves(r, registry) for r in raw[:2]],
                                   [waves(raw[2], registry)])
    compile_seconds = time.perf_counter() - started
    # No held-out cost is inspected until the validation choice is complete.
    holdouts = []
    original_layout = balanced_layout(registry)
    for run in (3, 4):
        episode = waves(read(f'{base}/run_{run}/pytest_evidence.json'), registry)
        holdouts.append({'run': run,
                         'selected_padded_bytes': touched_cost(selected, [episode])[0],
                         'original_padded_bytes': touched_cost(original_layout, [episode])[0]})
    result = {'schema': 'hact-v15-sparse-1', 'status': 'PASS', 'n': len(registry),
              'fit_validation_seconds': compile_seconds,
              'process_peak_rss_bytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
              'address_space_limit_bytes': 2 * 1024**3,
              'selected_order': list(selected.order), 'fit': info, 'holdouts': holdouts,
              'scope': 'new compact compiler replay; historical Packaging exclusions remain UNKNOWN'}
    write(OUT / 'sparse_packaging.json', result)
    print(json.dumps({k: result[k] for k in ('status', 'n', 'fit_validation_seconds', 'process_peak_rss_bytes')}))


def category(filename, function):
    # cProfile tt is exclusive: each function belongs to exactly one bucket.
    name = filename.replace('\\', '/')
    if 'hashlib' in function or 'hexdigest' in function or (name.endswith('/hact/certificates.py') and function == 'digest'):
        return 'hashing'
    if '/json/' in name or 'json' in function or (name.endswith('/hact/certificates.py') and function == 'canonical'):
        return 'json'
    if 'zlib' in function:
        return 'compression'
    if name.endswith('/hact/certificates.py'):
        return 'kernel_capsules'
    if name.endswith('/hact/tree.py'):
        return 'tree'
    return 'other'


def profile_case(case, arm):
    trajectory, layout = original.load_case(case)
    profiler = cProfile.Profile(timer=time.process_time)
    started = time.perf_counter()
    service = profiler.runcall(observer.make_service, trajectory, layout, arm + ':observer_disabled')
    total_waves = math.ceil(trajectory.n / 8)
    requests = {0, max(1, total_waves // 2), total_waves}
    signatures = []
    for epoch in range(total_waves + 1):
        if time.perf_counter() - started > 180:
            raise TimeoutError('profile case exceeded 180 seconds')
        snap = original.snapshot(trajectory, epoch)
        profiler.runcall(service._sync, snap)
        if epoch not in requests:
            continue
        for query in observer.old.frozen_queries():
            original.reference_answer(snap, query)
            for phase in ('cold', 'warm'):
                answer = profiler.runcall(service.query, query['query_id'], snap, query['s'],
                                          query['mode'], wave=query.get('wave'))
                signatures.append(observer.answer_signature(answer, snap, query))
    stats = pstats.Stats(profiler)
    buckets = Counter({name: 0.0 for name in ('hashing', 'json', 'compression', 'kernel_capsules', 'tree', 'other')})
    top = []
    for (filename, line, function), (primitive, calls, exclusive, cumulative, callers) in stats.stats.items():
        group = category(filename, function)
        buckets[group] += exclusive
        try:
            filename = str(Path(filename).relative_to(ROOT))
        except ValueError:
            filename = Path(filename).name if filename != '~' else '<builtin>'
        top.append({'file': filename, 'line': line, 'function': function,
                    'exclusive_seconds': exclusive, 'calls': calls, 'category': group})
    if not math.isclose(sum(buckets.values()), stats.total_tt, rel_tol=1e-12, abs_tol=1e-12):
        raise ValueError('exclusive profile buckets do not cover total')
    return {'project': case['project'], 'case': case['case'], 'arm': arm,
            'status': 'PASS', 'exclusive_total_seconds': stats.total_tt,
            'exclusive_seconds_by_category': dict(buckets),
            'top_functions': sorted(top, key=lambda x: -x['exclusive_seconds'])[:20],
            'answer_signatures': signatures, 'input_preparation_and_oracle_profiled': False}


def run():
    freeze()
    write(OUT / 'cap64_dispatch.json', {'schema': 'hact-v15-cap64-1', 'rows': cap64_replay()})
    env = dict(os.environ, OPENBLAS_NUM_THREADS='1', OMP_NUM_THREADS='1', PYTHONHASHSEED='0')
    try:
        proc = subprocess.run([sys.executable, '-m', 'experiments_v15.review_followups', '--sparse-child'],
                              cwd=ROOT, env=env, capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired:
        proc = None
        write(OUT / 'sparse_packaging.json', {'schema': 'hact-v15-sparse-1', 'status': 'UNKNOWN',
              'reason': 'declared 180-second child timeout'})
    if proc is not None and proc.returncode:
        write(OUT / 'sparse_packaging.json', {'schema': 'hact-v15-sparse-1', 'status': 'UNKNOWN',
              'reason': 'budgeted child failed', 'returncode': proc.returncode, 'diagnostic': proc.stderr[-2000:]})
    if proc is not None:
        print(proc.stdout.strip(), flush=True)
    cases = [c for c in read('results/v11/public_compiler/SERVICE_CASES.json') if c['project'] != 'packaging']
    if len(cases) != 10:
        raise ValueError('all ten admitted cases required')
    rows, started = [], time.perf_counter()
    for case in cases:
        previous = None
        for arm in ('counter', 'hact_selected'):
            if time.perf_counter() - started > 900:
                raise TimeoutError('total profiling budget exceeded')
            result = profile_case(case, arm)
            if previous is not None and result['answer_signatures'] != previous:
                raise ValueError('profiled HACT/counter answer mismatch')
            previous = result['answer_signatures']
            rows.append(result)
            print(json.dumps({'case': case['case'], 'arm': arm, 'status': result['status']}), flush=True)
    write(OUT / 'cpu_profile.json', {'schema': 'hact-v15-cpu-1', 'rows': rows,
          'scope': 'exclusive CPU under cProfile; not unprofiled elapsed time or causal allocation shares'})
    verify_freeze()


def check():
    verify_freeze()
    if read('results/v15/cap64_dispatch.json')['rows'] != cap64_replay():
        raise ValueError('cap64 replay changed')
    sparse = read('results/v15/sparse_packaging.json')
    if sparse['status'] == 'PASS':
        base = 'results/v11/public_checks_normalized/packaging'
        raw = [read(f'{base}/run_{i}/pytest_evidence.json') for i in range(3)]
        ids = tuple(raw[0]['registry'])
        layout, fit = select_sparse(ids, [waves(r, ids) for r in raw[:2]], [waves(raw[2], ids)])
        if fit != sparse['fit'] or list(layout.order) != sparse['selected_order']:
            raise ValueError('sparse fit/selection changed')
        for row in sparse['holdouts']:
            evidence = read(f"{base}/run_{row['run']}/pytest_evidence.json")
            if literal_cost(layout.to_dict(), evidence['executed']) != row['selected_padded_bytes']:
                raise ValueError('independent large-layout score differs')
            if literal_cost(balanced_layout(ids).to_dict(), evidence['executed']) != row['original_padded_bytes']:
                raise ValueError('independent large incumbent score differs')
        if not 0 < sparse['process_peak_rss_bytes'] < sparse['address_space_limit_bytes'] == 2 * 1024**3:
            raise ValueError('sparse resource receipt invalid')
    cpu = read('results/v15/cpu_profile.json')['rows']
    expected = {(c['case'], arm) for c in read('results/v11/public_compiler/SERVICE_CASES.json')
                if c['project'] != 'packaging' for arm in ('counter', 'hact_selected')}
    if len(cpu) != 20 or {(r['case'], r['arm']) for r in cpu} != expected:
        raise ValueError('incomplete profile cohort')
    for row in cpu:
        if row['status'] != 'PASS' or row['input_preparation_and_oracle_profiled']:
            raise ValueError('invalid profile scope')
        if not math.isclose(sum(row['exclusive_seconds_by_category'].values()), row['exclusive_total_seconds'], rel_tol=1e-12):
            raise ValueError('profile time accounting mismatch')
    for case, _ in expected:
        pair = [r for r in cpu if r['case'] == case]
        if pair[0]['answer_signatures'] != pair[1]['answer_signatures']:
            raise ValueError('retained profile answers differ')
    print(json.dumps({'status': 'PASS', 'dispatch_rows': 30, 'profile_arms': 20,
                      'sparse_status': sparse['status']}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--sparse-child', action='store_true')
    args = parser.parse_args()
    sparse_child() if args.sparse_child else check() if args.check else run()
