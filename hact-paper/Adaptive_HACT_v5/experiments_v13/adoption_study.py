"""Synthetic conformance and retrospective support diagnostics, not new trials."""
from __future__ import annotations
import argparse
from collections import Counter
from dataclasses import replace
from decimal import Decimal
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import random

from hact.tree import Node
from ichact.layout import Layout
from ichact.adoption import AdoptionPlan, assess_adoption, difference_envelope, paired_savings
from experiments_v11.strict_partition_witness import literal_trees, set_partitions, witness

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'results/v13/adoption.json'


def literal_score(layout, episode):
    """Independent dictionary/set traversal; no HACT tree/cost/coverage helper."""
    def visit(node):
        if not node['children']:
            return {layout['order'][node['lo']]}, 0
        covered, subtotal = set(), 0
        for child in node['children']:
            members, cost = visit(child)
            covered |= members
            subtotal += cost
        price = layout['model']['header'] + len(node['children']) * layout['model']['card']
        return covered, subtotal + price * (1 + sum(bool(covered & set(wave)) for wave in episode))
    return visit(layout['tree'])[1]


def layouts():
    leaves = tuple(Node(i, i) for i in range(6))
    registry = tuple(f'check-{i}' for i in range(6))
    flat = Layout(registry, tuple(range(6)), Node(0, 5, leaves))
    grouped = Layout(registry, tuple(range(6)), Node(0, 5, (Node(0, 3, leaves[:4]), *leaves[4:])))
    return flat, grouped


def episode(partition, n=6):
    return tuple(tuple(i for i in range(n) if block & (1 << i)) for block in partition)


def from_literal(tree, n):
    order = []
    def visit(value):
        lo = len(order)
        if type(value) is int:
            order.append(value)
            return Node(lo, lo)
        children = tuple(visit(child) for child in value)
        return Node(lo, len(order)-1, children)
    result = visit(tree)
    return Layout(tuple(f'check-{i}' for i in range(n)), tuple(order), result)


def exhaustive():
    flat, _ = layouts()
    partitions = tuple(episode(x) for x in set_partitions(63) if len(x) == 3)
    comparisons, minimum_slack = 0, None
    trees = literal_trees(tuple(range(6)))
    for tree in trees:
        candidate = from_literal(tree, 6)
        bound = difference_envelope(flat, candidate, max_wave_width=6, wave_count=3)
        plan = AdoptionPlan(flat, (candidate,), 6, 3, '0.05', '0', 1000, (0,))
        values = paired_savings(plan, partitions)[0]
        for waves, value in zip(partitions, values):
            independent = literal_score(flat.to_dict(), waves) - literal_score(candidate.to_dict(), waves)
            if value != independent or not bound['lower'] <= value <= bound['upper']:
                raise AssertionError('independent complete-partition range/scoring failure')
            slack = min(value - bound['lower'], bound['upper'] - value)
            minimum_slack = slack if minimum_slack is None else min(slack, minimum_slack)
            comparisons += 1
    return {'trees': len(trees), 'partitions': len(partitions), 'comparisons': comparisons,
            'minimum_envelope_slack': minimum_slack,
            'scope': 'all labeled unordered six-leaf trees and all three-block complete partitions'}


def synthetic():
    flat, grouped = layouts()
    installation = len(grouped.manifest_bytes()) + sum(price for _, price in grouped.coverage())
    plan = AdoptionPlan(flat, (grouped,), 6, 3, '0.05', '0', 1000, (installation,))
    bounds = difference_envelope(flat, grouped, max_wave_width=6, wave_count=3)
    distributions, law_records = witness()[1], []
    for law, distribution in distributions.items():
        values = Counter()
        for partition, probability in distribution.items():
            waves = episode(partition)
            value = literal_score(flat.to_dict(), waves) - literal_score(grouped.to_dict(), waves)
            values[value] += probability
        mean = sum(Fraction(value) * probability for value, probability in values.items())
        rows = []
        for seed in range(2026102200, 2026102220):
            rng = random.Random(seed)
            samples = rng.choices(tuple(values), weights=[float(x) for x in values.values()], k=100000)
            for m in (100, 1000, 10000, 100000):
                observed = Decimal(sum(samples[:m])) / Decimal(m)
                with __import__('decimal').localcontext() as context:
                    context.prec = 60
                    factor = ((Decimal(20).ln()) / (2 * Decimal(m))).sqrt()
                    lower = observed - bounds['width'] * factor - Decimal(installation) / Decimal(1000)
                    whole_lower = observed - bounds['whole_cost_width'] * factor - Decimal(installation) / Decimal(1000)
                rows.append({'seed': seed, 'episodes': m, 'mean_bytes': str(observed),
                             'paired_lower': str(lower), 'whole_lower': str(whole_lower),
                             'paired_adopt': lower > 0, 'whole_adopt': whole_lower > 0})
        law_records.append({'law': law, 'exact_mean_bytes': str(mean),
                            'saving_distribution': {str(x): str(p) for x, p in sorted(values.items())},
                            'rows': rows})
    # Exercise the actual API using one independently generated calibration set.
    rng = random.Random(2026102221)
    distribution = distributions['P']
    partitions = rng.choices(tuple(distribution), weights=[float(x) for x in distribution.values()], k=100000)
    calibration = tuple(episode(x) for x in partitions)
    advice = assess_adoption(plan, calibration, frozen_plan_digest=plan.uid,
                            sampling_justification='synthetic IID draws; fixed layouts and plan before this calibration stream')
    shifted = replace(plan, shift_radius='0.01')
    shifted_advice = assess_adoption(shifted, calibration, frozen_plan_digest=shifted.uid,
                                    sampling_justification='synthetic IID draws; declared sensitivity radius, not estimated drift')
    return {'plan': plan.uid, 'installation_bytes': installation, 'horizon': 1000,
            'envelope': bounds, 'laws': law_records, 'api_no_shift': advice,
            'api_shift_0_01': shifted_advice,
            'exact_P_maximum_drift_at_infinite_horizon': str(Fraction(32, bounds['width'])),
            'scope': 'synthetic conformance only; seeded pseudorandom draws, not software executions'}


def public_diagnostics():
    summary = json.loads((ROOT / 'results/v11/public_compiler/SUMMARY.json').read_text())
    shifted = json.loads((ROOT / 'results/v12/schedule_shift/SUMMARY.json').read_text())
    repaired = json.loads((ROOT / 'results/v12/schedule_generated_metadata/SUMMARY.json').read_text())
    admitted = [x for x in shifted['runs'] + repaired['runs'] if x.get('status') == 'PASS']
    rows = []
    for project in summary['projects']:
        name = project['project']
        if project['status'] != 'PASS':
            rows.append({'project': name, 'status': 'UNKNOWN', 'reason': 'historical resource exclusion retained'})
            continue
        directory = ROOT / 'results/v11/public_compiler' / name
        base = Layout.from_dict(json.loads((directory / 'historical_layout.json').read_text()))
        proposed = Layout.from_dict(json.loads((directory / 'selected_layout.json').read_text()))
        n = len(base.registry)
        envelope = difference_envelope(base, proposed, max_wave_width=8, wave_count=(n+7)//8)
        records = [x for x in admitted if x.get('project') == name]
        if len(records) != 6:
            raise AssertionError('six admitted dispatch shifts required per eligible project')
        savings = [x['costs']['historical'] - x['costs']['cap32'] for x in records]
        rows.append({'project': name, 'registry_size': n, 'envelope': envelope,
                     'dispatch_shift_count': len(savings), 'dispatch_shift_saved_bytes': savings,
                     'range_valid_on_retained_shifts': all(envelope['lower'] <= x <= envelope['upper'] for x in savings),
                     'status': 'UNKNOWN',
                     'reason': 'repeated snapshots/controlled interventions are not independent natural calibration; no justified deployment TV bound'})
    return rows


def report():
    source_files = ['ichact/adoption.py', 'experiments_v13/adoption_study.py',
                    'docs/V13_REVISION_CONTRACT.md', 'results/v11/public_compiler/SUMMARY.json',
                    'results/v12/schedule_shift/SUMMARY.json',
                    'results/v12/schedule_generated_metadata/SUMMARY.json']
    result = {'schema': 'hact-v13-adoption-study-1', 'exhaustive': exhaustive(),
              'synthetic': synthetic(), 'public_diagnostics': public_diagnostics(),
              'inputs': {x: hashlib.sha256((ROOT / x).read_bytes()).hexdigest() for x in source_files}}
    if not all(row.get('range_valid_on_retained_shifts', True) for row in result['public_diagnostics']):
        raise AssertionError('archived shift cost escaped structural support')
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    result = report()
    if args.check:
        if json.loads(OUTPUT.read_text()) != result:
            raise ValueError('v13 retained analysis differs; do not silently overwrite')
    else:
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        with OUTPUT.open('x') as stream:
            stream.write(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'status': 'PASS', 'exhaustive': result['exhaustive'],
                      'synthetic_api': result['synthetic']['api_no_shift']['status'],
                      'synthetic_api_shift': result['synthetic']['api_shift_0_01']['status'],
                      'public_rows': len(result['public_diagnostics'])}))


if __name__ == '__main__':
    main()
