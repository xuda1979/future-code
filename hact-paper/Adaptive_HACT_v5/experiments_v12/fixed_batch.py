"""Exact fixed-width lifting certificate, independent of the HACT scorer.

The implicit lifted laws allocate distinct fillers uniformly to block deficits,
then uniformly permute blocks and shuffle within each block. No Monte Carlo
estimate or exhaustive 24-leaf tree search is used. The optimization statement
is deliberately restricted to two embedded six-leaf layout choices.
"""
from __future__ import annotations

import argparse
from fractions import Fraction as F
from itertools import combinations, permutations, product
import json
from math import comb
from pathlib import Path

RESULT = Path(__file__).resolve().parents[1] / 'results/v12/fixed_batch.json'


def source_laws():
    """Direct three-colour assignments, separate from v11's subset recursion."""
    partitions = set()
    for assignment in product(range(3), repeat=6):
        if len(set(assignment)) == 3:
            partitions.add(tuple(sorted(tuple(i for i, a in enumerate(assignment) if a == colour)
                                        for colour in range(3))))
    types = {
        'B': ((0, 1), (2, 0), (2, 1)),
        'C': ((1, 0), (1, 1), (2, 1)),
        'D': ((1, 1), (1, 1), (2, 0)),
    }
    families = {name: tuple(sorted(p for p in partitions if tuple(sorted(
        (sum(i < 4 for i in block), sum(i >= 4 for i in block)) for block in p)) == kind))
                for name, kind in types.items()}
    assert len(partitions) == 90
    assert {k: len(v) for k, v in families.items()} == {'B': 12, 'C': 24, 'D': 12}
    a = ((0, 1, 2, 3), (4,), (5,))
    laws = {'P': {a: F(7, 8), **{p: F(1, 96) for p in families['B']}},
            'Q': {a: F(9, 10), **{p: F(1, 480) for p in families['C']},
                  **{p: F(1, 240) for p in families['D']}}}
    for law in laws.values():
        validate_law(law, 6, 3)
    return families, laws


def validate_law(law, n, q, width=None):
    if type(n) is not int or type(q) is not int or n < 1 or q < 2:
        raise ValueError('positive registry and at least two blocks required')
    if not law or sum(law.values()) != 1 or any(p < 0 for p in law.values()):
        raise ValueError('nonnegative probabilities summing to one required')
    for partition in law:
        leaves = [i for block in partition for i in block]
        if len(partition) != q or any(not block for block in partition):
            raise ValueError('exactly q nonempty source blocks required')
        if any(type(i) is not int for i in leaves) or sorted(leaves) != list(range(n)):
            raise ValueError('each declared check must complete exactly once')
        if width is not None and any(len(block) > width for block in partition):
            raise ValueError('a source block exceeds the fixed width')


def _lift_contract(law, n, q, width):
    if type(width) is not int or width < 2 or q * width - n < 2:
        raise ValueError('integer width >=2 and at least two fillers required')
    validate_law(law, n, q, width)
    return q * width - n


def same_wave_moments(law, n, q):
    validate_law(law, n, q)
    matrix = [[F(0) for _ in range(n)] for _ in range(n)]
    for partition, probability in law.items():
        for block in partition:
            for i in block:
                for j in block:
                    matrix[i][j] += probability
    return matrix


def lifted_moments(law, n=6, q=3, width=8):
    """Population lift formula depending only on original pairwise moments."""
    fillers = _lift_contract(law, n, q, width)
    old = same_wave_moments(law, n, q)
    matrix = [[F(i == j) for j in range(q * width)] for i in range(q * width)]
    for i in range(n):
        for j in range(n):
            matrix[i][j] = old[i][j]
        mixed = (width - 1 - sum(old[i][j] for j in range(n) if j != i)) / fillers
        for j in range(n, q * width):
            matrix[i][j] = matrix[j][i] = mixed
    pairs = sum(old[i][j] for i, j in combinations(range(n), 2))
    ff = (q * width * (width - 1) - (2 * width - 2) * n + 2 * pairs) / (fillers * (fillers - 1))
    for i, j in combinations(range(n, q * width), 2):
        matrix[i][j] = matrix[j][i] = ff
    return matrix


def conditional_moments(law, n=6, q=3, width=8):
    """Independent finite-source average using conditional allocation counts."""
    fillers = _lift_contract(law, n, q, width)
    size = q * width
    matrix = [[F(i == j) for j in range(size)] for i in range(size)]
    for i, j in combinations(range(size), 2):
        value = F(0)
        for partition, probability in law.items():
            deficits = [width - len(block) for block in partition]
            if j < n:
                conditional = F(any(i in block and j in block for block in partition))
            elif i < n:
                conditional = F(next(d for block, d in zip(partition, deficits) if i in block), fillers)
            else:
                conditional = F(sum(d * (d - 1) for d in deficits), fillers * (fillers - 1))
            value += probability * conditional
        matrix[i][j] = matrix[j][i] = value
    return matrix


def rank_pair_probability(same_wave, first_rank, second_rank, q=3, width=8):
    """Joint rank law of two DISTINCT checks, after both uniform shuffles."""
    if type(q) is not int or type(width) is not int or q < 2 or width < 2:
        raise ValueError('q,width must be integers >=2')
    if not 0 <= same_wave <= 1:
        raise ValueError('invalid co-wave probability')
    if any(type(r) is not int or not 0 <= r < q * width for r in (first_rank, second_rank)):
        raise ValueError('rank outside complete epoch')
    if first_rank == second_rank:
        return F(0)
    if first_rank // width == second_rank // width:
        return F(same_wave) / (q * width * (width - 1))
    return (1 - F(same_wave)) / (q * (q - 1) * width * width)


def complete_order(partition, width=8, filler_order=None, block_order=None):
    """One supported padding allocation, for literal batching conformance."""
    n, q = sum(map(len, partition)), len(partition)
    _lift_contract({partition: F(1)}, n, q, width)
    fillers = tuple(range(n, q * width)) if filler_order is None else tuple(filler_order)
    if sorted(fillers) != list(range(n, q * width)):
        raise ValueError('filler permutation does not cover distinct filler checks')
    order = tuple(range(q)) if block_order is None else tuple(block_order)
    if sorted(order) != list(range(q)):
        raise ValueError('invalid block permutation')
    padded, offset = [], 0
    for block in partition:
        deficit = width - len(block)
        padded.append(tuple(block) + fillers[offset:offset + deficit])
        offset += deficit
    return tuple(i for index in order for i in padded[index])


def embedded_trees():
    filler_tree = (tuple(range(6, 12)), tuple(range(12, 18)), tuple(range(18, 24)))
    return {'flat': (tuple(range(6)), filler_tree),
            'group': (((0, 1, 2, 3), 4, 5), filler_tree)}


def tree_packets(tree, n, fanout=8):
    """Return literal coverage sets/arity; reject malformed global trees."""
    packets = []
    def visit(node):
        if type(node) is int:
            return {node}
        if not isinstance(node, (list, tuple)) or not 2 <= len(node) <= fanout:
            raise ValueError('invalid packet arity')
        covered = set()
        for child in node:
            labels = visit(child)
            if covered & labels:
                raise ValueError('duplicate tree leaf')
            covered |= labels
        packets.append((frozenset(covered), len(node)))
        return covered
    if visit(tree) != set(range(n)):
        raise ValueError('tree does not cover the complete registry')
    return packets


def literal_cost(tree, order, width=8, header=512, slot=320, fanout=8):
    if sorted(order) != list(range(len(order))) or len(order) % width:
        raise ValueError('complete equal-width epoch required')
    waves = [set(order[i:i + width]) for i in range(0, len(order), width)]
    return sum((header + slot * d) * (1 + sum(bool(coverage & wave) for wave in waves))
               for coverage, d in tree_packets(tree, len(order), fanout))


def source_tree_cost(tree, law, n=6, q=3, header=512, slot=320):
    validate_law(law, n, q)
    return sum((header + slot * d) * (1 + sum(probability * sum(bool(coverage & set(block))
               for block in partition) for partition, probability in law.items()))
               for coverage, d in tree_packets(tree, n))


def padded_tree_cost(tree, law, n=6, q=3, width=8, header=512, slot=320):
    """Exact hypergeometric hit probability; all filler allocations integrated."""
    fillers = _lift_contract(law, n, q, width)
    total = F(0)
    for coverage, arity in tree_packets(tree, q * width):
        original = coverage & set(range(n))
        k = len(coverage) - len(original)
        hits = F(0)
        for partition, probability in law.items():
            for block in partition:
                if original & set(block):
                    hit = F(1)
                else:
                    available = fillers - (width - len(block))
                    hit = 1 - F(comb(available, k) if available >= k else 0, comb(fillers, k))
                hits += probability * hit
        total += (header + slot * arity) * (1 + hits)
    return total


def build_report():
    families, laws = source_laws()
    matrices = {name: lifted_moments(law) for name, law in laws.items()}
    assert matrices['P'] == matrices['Q']
    assert all(matrices[name] == conditional_moments(law) for name, law in laws.items())
    trees = embedded_trees()
    costs = {name: {key: padded_tree_cost(tree, law) for key, tree in trees.items()}
             for name, law in laws.items()}
    gaps = {'P': costs['P']['flat'] - costs['P']['group'],
            'Q': costs['Q']['group'] - costs['Q']['flat']}
    assert gaps == {'P': F(32), 'Q': F(512, 5)}
    checked = 0
    for law in laws.values():
        for partition in law:
            for fillers in (tuple(range(6, 24)), tuple(reversed(range(6, 24)))):
                for blocks in permutations(range(3)):
                    order = complete_order(partition, filler_order=fillers, block_order=blocks)
                    delta = literal_cost(trees['group'], order) - literal_cost(trees['flat'], order)
                    direct = source_tree_cost(((0, 1, 2, 3), 4, 5), {partition: F(1)}) - source_tree_cost(tuple(range(6)), {partition: F(1)})
                    assert delta == direct
                    checked += 1
    m = matrices['P']
    classes = {'G-G': m[0][1], 'G-O': m[0][4], 'O-O': m[4][5],
               'G-filler': m[0][6], 'O-filler': m[4][6], 'filler-filler': m[6][7]}
    ranks = {name: {'same_wave': str(p),
             'per_ordered_distinct_rank_pair_same_batch': str(rank_pair_probability(p, 0, 1)),
             'per_ordered_rank_pair_different_batches': str(rank_pair_probability(p, 0, 8))}
             for name, p in classes.items()}
    return {'schema': 'hact-v12-fixed-batch-lift-1', 'status': 'PASS',
            'kind': 'exact constructed analytical law, not new software executions',
            'source_checks': 6, 'fillers': 18, 'complete_checks': 24, 'batches': 3, 'batch_width': 8,
            'cost_model': {'header': 512, 'slot': 320, 'fanout': 8, 'include_cold_build': True},
            'source_family_sizes': {name: len(parts) for name, parts in families.items()},
            'source_laws': {name: [{'partition': partition, 'probability': str(p)} for partition, p in law.items()]
                            for name, law in laws.items()},
            'allocation': 'uniform distinguishable-filler allocation to block deficits; uniform block permutation and independent uniform within-block permutations',
            'same_wave_moments': {name: [[str(x) for x in row] for row in m] for name, m in matrices.items()},
            'single_check_rank_probability': '1/24', 'bivariate_rank_classes': ranks,
            'decision_class': 'exactly two specified embedded layouts; all other subtrees and ancestor arities fixed',
            'global_24_leaf_optimality_claimed': False,
            'trees': trees, 'expected_total_padded_bytes': {name: {key: str(x) for key, x in row.items()} for name, row in costs.items()},
            'regret_wrong_choice': {name: str(value) for name, value in gaps.items()},
            'deterministic_minimax_regret': str(min(gaps.values())),
            'randomized_minimax_regret': str(gaps['P'] * gaps['Q'] / sum(gaps.values())),
            'optimal_group_probability': str(gaps['P'] / sum(gaps.values())),
            'representative_complete_orders_checked': checked,
            'representative_check_scope': 'two supported filler permutations and all six block permutations per source support point; population claims use exact formulas, not these examples',
            'limitations': ['No unrestricted 24-leaf global-optimum claim.',
                            'Pairwise-only interface supplies exact population summaries; higher-order rank information can distinguish the laws.',
                            'Constructed laws do not establish prevalence, useful magnitude or service acceleration in public software.']}


def verify_certificate(report):
    """Fail closed on numerical, completeness or scope corruption."""
    families, laws = source_laws()
    if tuple(report.get(key) for key in ('source_checks', 'fillers', 'complete_checks', 'batches', 'batch_width')) != (6, 18, 24, 3, 8):
        raise ValueError('incorrect fixed-batch contract')
    if report.get('cost_model') != {'header': 512, 'slot': 320, 'fanout': 8, 'include_cold_build': True}:
        raise ValueError('incorrect cost model')
    if report.get('source_family_sizes') != {name: len(parts) for name, parts in families.items()}:
        raise ValueError('source family sizes differ')
    source_records = {name: [{'partition': partition, 'probability': str(p)} for partition, p in law.items()]
                      for name, law in laws.items()}
    if json.loads(json.dumps(report.get('source_laws'))) != json.loads(json.dumps(source_records)):
        raise ValueError('source law certificate differs')
    if report.get('global_24_leaf_optimality_claimed') is not False:
        raise ValueError('unsupported global optimality claim')
    if json.loads(json.dumps(report.get('trees'))) != json.loads(json.dumps(embedded_trees())):
        raise ValueError('candidate tree contract differs')
    values = {}
    for name, law in laws.items():
        supplied = [[F(x) for x in row] for row in report['same_wave_moments'][name]]
        if supplied != conditional_moments(law):
            raise ValueError('pairwise summary does not match exact conditional allocation')
        values[name] = {key: F(x) for key, x in report['expected_total_padded_bytes'][name].items()}
        for key, tree in embedded_trees().items():
            if values[name][key] != padded_tree_cost(tree, law):
                raise ValueError('full padded cost differs')
        group_minus_flat = source_tree_cost(((0, 1, 2, 3), 4, 5), law) - source_tree_cost(tuple(range(6)), law)
        if values[name]['group'] - values[name]['flat'] != group_minus_flat:
            raise ValueError('local cost difference was not preserved')
    gp = values['P']['flat'] - values['P']['group']
    gq = values['Q']['group'] - values['Q']['flat']
    if report['regret_wrong_choice'] != {'P': str(gp), 'Q': str(gq)}:
        raise ValueError('wrong-choice regret differs')
    expected = {'deterministic_minimax_regret': min(gp, gq),
                'randomized_minimax_regret': gp * gq / (gp + gq),
                'optimal_group_probability': gp / (gp + gq)}
    if any(F(report[key]) != value for key, value in expected.items()):
        raise ValueError('minimax certificate differs')
    classes = {'G-G': (0, 1), 'G-O': (0, 4), 'O-O': (4, 5),
               'G-filler': (0, 6), 'O-filler': (4, 6), 'filler-filler': (6, 7)}
    if set(report['bivariate_rank_classes']) != set(classes):
        raise ValueError('incomplete rank classes')
    if F(report['single_check_rank_probability']) != F(1, 24):
        raise ValueError('single-check rank mass differs')
    moments = conditional_moments(laws['P'])
    for name, row in report['bivariate_rank_classes'].items():
        p = F(row['same_wave'])
        i, j = classes[name]
        if p != moments[i][j]:
            raise ValueError('rank class does not match actual co-wave probability')
        if F(row['per_ordered_distinct_rank_pair_same_batch']) != rank_pair_probability(p, 0, 1):
            raise ValueError('same-batch rank mass differs')
        if F(row['per_ordered_rank_pair_different_batches']) != rank_pair_probability(p, 0, 8):
            raise ValueError('different-batch rank mass differs')
    if report['representative_complete_orders_checked'] != sum(len(law) for law in laws.values()) * 12:
        raise ValueError('literal conformance count differs')
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    report = json.loads(json.dumps(build_report()))
    verify_certificate(report)
    encoded = json.dumps(report, indent=2, sort_keys=True) + '\n'
    if args.write:
        RESULT.parent.mkdir(parents=True, exist_ok=True)
        RESULT.write_text(encoded)
    elif not RESULT.exists() or RESULT.read_text() != encoded:
        raise SystemExit('fixed-batch certificate differs; inspect before --write')
    print(json.dumps({'status': 'PASS', 'complete_checks': 24, 'batch_width': 8,
                      'wrong_choice_regrets': report['regret_wrong_choice'],
                      'randomized_minimax_regret': report['randomized_minimax_regret'],
                      'orders_checked': report['representative_complete_orders_checked']}))


if __name__ == '__main__':
    main()
