"""Retained-data checks independent of the sparse proposal and profiler runner."""
from collections import Counter
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROJECTS = {'click', 'jinja', 'pluggy', 'attrs', 'exceptiongroup'}
CATEGORIES = {'hashing', 'json', 'compression', 'kernel_capsules', 'tree', 'other'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify(dispatch, cpu, sparse):
    expected = {(p, policy, seed) for p in PROJECTS for policy in ('files', 'items')
                for seed in (2026102101, 2026102102, 2026102103)}
    rows = dispatch['rows']
    require(dispatch['schema'] == 'hact-v15-cap64-1' and len(rows) == 30 and
            {(r['project'], r['policy'], r['seed']) for r in rows} == expected,
            'missing/duplicate secondary comparison')
    outcomes = {}
    for policy in ('files', 'items'):
        selected = [r for r in rows if r['policy'] == policy]
        for base in ('historical', 'exchangeable'):
            require(all(type(r['costs'][base]) is int and r['costs'][base] > 0 and
                        type(r['costs']['cap64']) is int and r['costs']['cap64'] > 0 for r in selected),
                    'invalid retained integer price')
            outcomes[policy + '_vs_' + base] = dict(Counter('win' if r['costs']['cap64'] < r['costs'][base]
                 else 'loss' if r['costs']['cap64'] > r['costs'][base] else 'tie' for r in selected))
    require(outcomes['files_vs_exchangeable'] == {'win': 15} and
            outcomes['items_vs_exchangeable'] == {'loss': 15}, 'reported cap64 boundary differs')
    require(cpu['schema'] == 'hact-v15-cpu-1' and len(cpu['rows']) == 20, 'missing profile arms')
    keys = {(p, f'{p}_run_{run}', a) for p in PROJECTS for run in (3, 4) for a in ('counter', 'hact_selected')}
    require({(r['project'], r['case'], r['arm']) for r in cpu['rows']} == keys, 'profile cohort changed')
    answers = 0
    for row in cpu['rows']:
        times = row['exclusive_seconds_by_category']
        require(set(times) == CATEGORIES and all(math.isfinite(v) and v >= 0 for v in times.values()),
                'invalid exclusive category')
        require(row['status'] == 'PASS' and row['input_preparation_and_oracle_profiled'] is False,
                'profile scope changed')
        require(row['exclusive_total_seconds'] > 0 and math.isclose(sum(times.values()),
                row['exclusive_total_seconds'], rel_tol=1e-12), 'exclusive categories overlap or lose time')
        require(len(row['answer_signatures']) == 42, 'missing profile answers')
        answers += len(row['answer_signatures'])
        partner = next(x for x in cpu['rows'] if x['case'] == row['case'] and x['arm'] != row['arm'])
        require(partner['answer_signatures'] == row['answer_signatures'], 'paired answers changed')
    require(sparse['schema'] == 'hact-v15-sparse-1' and sparse['status'] in ('PASS', 'UNKNOWN'), 'bad sparse result')
    if sparse['status'] == 'PASS':
        require(sparse['n'] == 26948 and sorted(sparse['selected_order']) == list(range(sparse['n'])),
                'sparse registry changed')
        require(sparse['fit']['training_episodes'] == 2 and sparse['fit']['training_waves'] == 6738,
                'sparse fitting split changed')
        require(sparse['fit']['positive_edges'] == 94350 and sparse['fit']['dense_affinity_allocated'] is False,
                'sparse positive-pair receipt changed')
        require(sparse['address_space_limit_bytes'] == 2 * 1024**3 and
                0 < sparse['process_peak_rss_bytes'] < sparse['address_space_limit_bytes'], 'invalid memory receipt')
        require([r['run'] for r in sparse['holdouts']] == [3, 4], 'sparse holdouts changed')
        require(all(r['selected_padded_bytes'] == 70116096 and r['original_padded_bytes'] == 111199936
                    for r in sparse['holdouts']), 'sparse retained price changed')
    return {'status': 'PASS', 'dispatch_rows': len(rows), 'profile_answers': answers,
            'sparse_status': sparse['status'], 'outcomes': outcomes,
            'scope': 'retained accounting; literal cost replay is a separate required gate'}


def main():
    def read(p):
        return json.loads((ROOT / p).read_text())
    freeze = read('results/v15/FREEZE.json')
    for name, expected in freeze['files'].items():
        require(hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == expected, 'source/input binding differs')
    context = read('results/v15/POST_RUN_CONTEXT.json')
    scorer = context['unmodified_literal_scorer']
    require(context['scope'].startswith('post-run') and scorer['matches_parent_commit'] is True,
            'post-run dependency context mislabeled')
    require(hashlib.sha256((ROOT / scorer['path']).read_bytes()).hexdigest() == scorer['sha256'],
            'literal scorer dependency changed')
    result = verify(read('results/v15/cap64_dispatch.json'), read('results/v15/cpu_profile.json'),
                    read('results/v15/sparse_packaging.json'))
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
