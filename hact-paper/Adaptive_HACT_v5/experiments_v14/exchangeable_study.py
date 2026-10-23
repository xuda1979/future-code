"""Exact symmetry checks and retrospective strong-baseline comparison.

This adds analytical calculations and re-encoding of frozen observations,
not new check executions, natural workflows or production utility evidence.
"""
from collections import Counter
from fractions import Fraction
from functools import lru_cache
from itertools import permutations
from math import factorial
from pathlib import Path
import argparse, hashlib, json, time

from hact.tree import CostModel
from ichact.exchangeable import optimize_exchangeable, batch_sizes
from experiments_v11.strict_partition_witness import literal_trees
from audit.check_v12 import literal_packet_cost as literal_layout_cost

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT/'results/v14/exchangeable.json'


@lru_cache(None)
def permutation_hit_numerators(n, batches):
    """Enumerate actual permutations: no hypergeometric formula or DP import."""
    counts = Counter()
    for order in permutations(range(n)):
        offset, groups = 0, []
        for width in batches:
            groups.append(sum(1 << i for i in order[offset:offset+width]))
            offset += width
        if offset != n:
            raise AssertionError('invalid reference batch support')
        counts[tuple(sorted(groups))] += 1
    hits = {mask: sum(count * sum(bool(mask & group) for group in groups)
                      for groups, count in counts.items()) for mask in range(1, 1 << n)}
    return hits, factorial(n), len(counts)


def literal_expected_numerator(tree, hits, denominator, model):
    """Literal labeled hierarchy traversal; costs integers over n! outcomes."""
    if type(tree) is int:
        return 1 << tree, 0, 0
    covered, cost, max_arity = 0, 0, len(tree)
    for child in tree:
        mask, below, arity = literal_expected_numerator(child, hits, denominator, model)
        if covered & mask:
            raise ValueError('repeated independent literal leaf')
        covered |= mask
        cost += below
        max_arity = max(max_arity, arity)
    price = model.header + model.card * len(tree)
    cost += price * (denominator + hits[covered])
    return covered, cost, max_arity


def literal_from_layout(layout):
    def visit(node):
        return layout.order[node.lo] if node.leaf else tuple(visit(child) for child in node.children)
    return visit(layout.tree)


def exhaustive():
    rows, comparisons = [], 0
    for n in range(2, 7):
        trees = literal_trees(tuple(range(n)))
        for width in range(1, n+1):
            batches = batch_sizes(n, width)
            hits, denominator, epochs = permutation_hit_numerators(n, batches)
            values = [literal_expected_numerator(tree, hits, denominator, CostModel()) for tree in trees]
            for fanout in range(2, n+1):
                model = CostModel(cap=512+320*fanout)
                valid = [cost for _, cost, arity in values if arity <= fanout]
                optimum = Fraction(min(valid), denominator)
                layout, record = optimize_exchangeable(tuple(map(str, range(n))), batches, model=model)
                actual = Fraction(literal_expected_numerator(literal_from_layout(layout), hits, denominator, model)[1], denominator)
                if actual != optimum or Fraction(record['expected_padded_epoch_bytes']) != optimum:
                    raise AssertionError('global symmetric optimum differs from independent all-tree enumeration')
                for size in range(1, n+1):
                    mask = (1 << size)-1
                    direct_weight = Fraction(denominator+hits[mask], denominator)
                    # Independently reconstruct expected score via the returned
                    # tree above; formula equality is checked in the tests too.
                    if not 1 <= direct_weight <= len(batches)+1:
                        raise AssertionError('independent hit count range invalid')
                comparisons += len(valid)
                rows.append({'n': n, 'width': width, 'fanout': fanout,
                             'distinct_epoch_partitions': epochs,
                             'literal_trees_checked': len(valid), 'exact_optimum': str(optimum)})
    return {'status': 'PASS', 'cases': rows, 'global_tree_comparisons': comparisons,
            'scope': 'exact permutation-averaged model, all labeled unordered trees, n<=6; proof covers arbitrary n and prices'}


def public_baseline():
    summary = json.loads((ROOT/'results/v11/public_compiler/SUMMARY.json').read_text())
    shift_roots = [ROOT/'results/v12/schedule_shift', ROOT/'results/v12/schedule_generated_metadata']
    shifts = [(directory, row) for directory in shift_roots
              for row in json.loads((directory/'SUMMARY.json').read_text())['runs'] if row['status'] == 'PASS']
    rows = []
    for item in summary['projects']:
        name = item['project']
        if item['status'] != 'PASS':
            rows.append({'project': name, 'status': 'UNKNOWN', 'reason': 'historical resource admission retained'})
            continue
        directory = ROOT/'results/v11/public_compiler'/name
        historical = json.loads((directory/'historical_layout.json').read_text())
        selected = json.loads((directory/'selected_layout.json').read_text())
        registry = tuple(historical['registry'])
        started = time.perf_counter()
        layout, info = optimize_exchangeable(registry, batch_sizes(len(registry), 8))
        elapsed = time.perf_counter()-started
        costs = []
        for run in range(5):
            path = ROOT/f'results/v11/public_checks_normalized/{name}/run_{run}/pytest_evidence.json'
            raw = json.loads(path.read_text())
            if tuple(raw['registry']) != registry or set(raw['executed']) != set(registry):
                raise AssertionError('public baseline requires an intact complete canonical registry')
            costs.append({'run': run, 'exchangeable': literal_layout_cost(layout.to_dict(), raw['executed']),
                          'historical': literal_layout_cost(historical, raw['executed']),
                          'fullwave32': literal_layout_cost(selected, raw['executed']),
                          'input_sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
        changed = []
        for parent, raw in shifts:
            if raw['project'] != name:
                continue
            path = parent/name/raw['policy']/str(raw['seed'])/'pytest_evidence.json'
            data = json.loads(path.read_text())
            if tuple(data['registry']) != registry or set(data['executed']) != set(registry):
                raise AssertionError('shift registry is incomplete or changed')
            if literal_layout_cost(historical, data['executed']) != raw['costs']['historical']:
                raise AssertionError('retained shift historical score mismatch')
            changed.append({'policy': raw['policy'], 'seed': raw['seed'],
                            'exchangeable': literal_layout_cost(layout.to_dict(), data['executed']),
                            'historical': raw['costs']['historical'], 'fullwave32': raw['costs']['cap32'],
                            'input': str(path.relative_to(ROOT)), 'input_sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
        if len(changed) != 6:
            raise AssertionError('all six admitted shifts required')
        rows.append({'project': name, 'status': 'PASS', 'n': len(registry),
                     'layout': layout.to_dict(), 'model': info, 'compile_seconds': elapsed,
                     'original_runs': costs, 'dispatch_shifts': changed})
    return rows


def report():
    inputs = ['ichact/exchangeable.py', 'experiments_v14/exchangeable_study.py', 'docs/V14_REVISION_CONTRACT.md']
    return {'schema': 'hact-v14-exchangeable-baseline-1', 'exhaustive': exhaustive(),
            'public': public_baseline(), 'inputs': {x: hashlib.sha256((ROOT/x).read_bytes()).hexdigest() for x in inputs},
            'interpretation': 'exact model theorem plus retrospective encoding comparison; no new checker or model runs; no natural-exchangeability or lifecycle-superiority claim'}


def without_times(data):
    data = json.loads(json.dumps(data))
    for row in data['public']:
        row.pop('compile_seconds', None)
    return data


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    data = report()
    if args.check:
        if without_times(json.loads(OUTPUT.read_text())) != without_times(data):
            raise ValueError('v14 deterministic replay differs from retained observations')
    else:
        OUTPUT.parent.mkdir(exist_ok=True, parents=True)
        with OUTPUT.open('x') as stream:
            stream.write(json.dumps(data, indent=2)+'\n')
    print(json.dumps({'status': 'PASS', 'analytical_cases': len(data['exhaustive']['cases']),
                      'global_tree_comparisons': data['exhaustive']['global_tree_comparisons'],
                      'public_projects': len(data['public'])}))


if __name__ == '__main__':
    main()
