"""Prepare an isolated, fixed-policy re-execution; never overwrite the release."""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
MARKER = '.prepared_reexecution.json'


def prepare(output: Path):
    output = output.resolve()
    if output.exists() or output.is_relative_to(ROOT) or ROOT.is_relative_to(output):
        raise ValueError('output must be a new directory outside this artifact')
    def ignore(directory, names):
        denied = {n for n in names if n in {'__pycache__', '.pytest_cache', 'build', 'dist'}
                  or n.endswith(('.pyc', '.egg-info'))}
        if Path(directory).resolve() == ROOT:
            denied.update({'results', 'MANIFEST.json', MARKER})
        return list(denied)
    shutil.copytree(ROOT, output, ignore=ignore)
    results = output / 'results'
    results.mkdir()
    for name in ('baselines', 'mutants'):
        shutil.copytree(ROOT / 'results' / name, results / name)
    shutil.copy2(ROOT / 'results/plans.json', results / 'plans.json')
    (output / MARKER).write_text(json.dumps({
        'mode': 'fixed-policy re-execution', 'prepared_from': str(ROOT),
        'plans_sha256': hashlib.sha256((results / 'plans.json').read_bytes()).hexdigest(),
        'warning': 'Original baseline timings/profiles are frozen policy inputs, not new timing observations.'
    }, indent=2))
    print(json.dumps({'prepared': str(output), 'executed_project_code': False}, indent=2))


def run_prepared():
    marker = ROOT / MARKER
    if not marker.is_file():
        raise ValueError('refusing to run in the delivered artifact; prepare a new copy first')
    if (ROOT / 'results/reexecution_started.json').exists():
        raise ValueError('run already started; use another new directory rather than overwriting')
    record = json.loads(marker.read_text())
    if hashlib.sha256((ROOT / 'results/plans.json').read_bytes()).hexdigest() != record['plans_sha256']:
        raise ValueError('frozen policy changed')
    (ROOT / 'results/reexecution_started.json').write_text(json.dumps({'unix_time': time.time()}))
    sys.path.insert(0, str(ROOT))
    from experiments.runner import execute
    from experiments.benchmarks import SCOPES
    from experiments.mutations import run_one
    for project in SCOPES:
        prefix = 'future_core' if project == 'future' else project
        base = json.loads((ROOT / 'results/baselines' / f'{prefix}_plain.json').read_text())
        fresh = execute(project, ROOT / 'vendor' / project,
                        ROOT / 'results/new_baselines' / f'{project}.json')
        if (fresh['registry'] != base['registry'] or fresh['returncode'] != 0 or
                set(fresh['records']) != set(base['registry']) or
                any(r['status'] != 'PASS' for r in fresh['records'].values())):
            raise RuntimeError(f'{project}: baseline or registry incompatible; preserving evidence')
    rows = json.loads((ROOT / 'docs/MUTATION_PLAN.json').read_text())
    rows += json.loads((ROOT / 'docs/CONFIRMATION_PLAN.json').read_text())['rows']
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(run_one, row): row['id'] for row in rows}
        for future in as_completed(futures):
            result = future.result()
            print(futures[future], result['returncode'], flush=True)
    env = dict(os.environ, PYTHONPATH=str(ROOT))
    def command(args, log):
        with (ROOT / 'results' / log).open('w') as stream:
            result = subprocess.run([sys.executable] + args, cwd=ROOT, env=env,
                                    stdout=stream, stderr=subprocess.STDOUT)
        if result.returncode:
            raise RuntimeError(f'failed command {args}; inspect results/{log}')
    for module in ('evaluate_frozen', 'timing', 'confirmation_timing', 'summarize',
                   'wrapper_smoke', 'overheads'):
        command(['-m', f'experiments.{module}'], f'{module}_reexecution.log')
    command(['-m', 'pytest', '-q', 'tests', 'tests_v1',
             '--junitxml=results/final_tests.xml'], 'final_tests.log')
    command(['-m', 'experiments.report_extras'], 'report_extras_reexecution.log')
    command(['audit/independent_check.py'], 'audit_reexecution.log')
    print('Re-execution completed. Timing values belong to this new run, not the published manuscript.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--prepare-only', action='store_true')
    parser.add_argument('--run-prepared', action='store_true')
    args = parser.parse_args()
    if args.run_prepared:
        if args.output or args.prepare_only:
            parser.error('--run-prepared cannot be combined with preparation flags')
        run_prepared()
    elif args.output and args.prepare_only:
        prepare(args.output)
    else:
        parser.error('use --output NEW_DIRECTORY --prepare-only, or --run-prepared')

if __name__ == '__main__':
    main()
