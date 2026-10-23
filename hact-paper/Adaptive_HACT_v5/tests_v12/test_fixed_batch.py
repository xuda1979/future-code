"""Exact allocation enumeration and independent fixed-eight conformance."""
from copy import deepcopy
from fractions import Fraction as F
from itertools import combinations, permutations, product
import json

import pytest

from experiments_v12.fixed_batch import (
    RESULT, build_report, complete_order, conditional_moments, embedded_trees,
    lifted_moments, literal_cost, padded_tree_cost, rank_pair_probability,
    same_wave_moments, source_laws, source_tree_cost, validate_law,
    verify_certificate,
)


def exhaustive_small_lift(law, width=4):
    """Enumerate assignments of all six distinct fillers, with no lift formula."""
    output = {}
    for blocks, mass in law.items():
        valid = []
        for colours in product(range(3), repeat=6):
            padded = tuple(tuple(block) + tuple(6 + i for i, colour in enumerate(colours) if colour == index)
                           for index, block in enumerate(blocks))
            if all(len(block) == width for block in padded):
                valid.append(padded)
        assert valid
        for padded in valid:
            output[padded] = output.get(padded, F(0)) + mass / len(valid)
    assert sum(output.values()) == 1
    return output


@pytest.fixture(scope='module')
def laws():
    return source_laws()[1]


@pytest.fixture(scope='module')
def small_lifts(laws):
    return {name: exhaustive_small_lift(law) for name, law in laws.items()}


def test_independent_source_enumeration_reproduces_exact_six_check_moments(laws):
    p, q = (same_wave_moments(laws[name], 6, 3) for name in ('P', 'Q'))
    assert p == q
    for i, j in combinations(range(6), 2):
        assert p[i][j] == (F(11, 12) if j < 4 else F(0) if i >= 4 else F(1, 32))
    group = ((0, 1, 2, 3), 4, 5)
    assert source_tree_cost(tuple(range(6)), laws['P']) == 9728
    assert source_tree_cost(group, laws['P']) == 9696
    assert source_tree_cost(group, laws['Q']) == F(49152, 5)


@pytest.mark.parametrize('name', ['P', 'Q'])
def test_full_distinguishable_filler_enumeration_confirms_lift_formula(name, laws, small_lifts):
    # This is exhaustive at w=4,F=6, not a random sample of the 24-check law.
    brute = [[F(0) for _ in range(12)] for _ in range(12)]
    for blocks, probability in small_lifts[name].items():
        assert sorted(i for block in blocks for i in block) == list(range(12))
        for block in blocks:
            for i in block:
                for j in block:
                    brute[i][j] += probability
    assert brute == lifted_moments(laws[name], width=4)
    assert brute == conditional_moments(laws[name], width=4)


def test_fixed_eight_population_moments_match_and_obey_block_cardinality(laws):
    p = lifted_moments(laws['P'])
    assert p == lifted_moments(laws['Q'])
    assert p == conditional_moments(laws['P']) == conditional_moments(laws['Q'])
    assert p[0][6] == F(67, 288)
    assert p[4][6] == F(55, 144)
    assert p[6][7] == F(191, 612)
    assert all(sum(row) == 8 and row[i] == 1 for i, row in enumerate(p))


@pytest.mark.parametrize('same', [F(11, 12), F(1, 32), F(0), F(67, 288), F(55, 144), F(191, 612), F(1)])
def test_bivariate_rank_mass_has_exact_unit_total_and_uniform_marginals(same):
    matrix = [[rank_pair_probability(same, i, j) for j in range(24)] for i in range(24)]
    assert sum(map(sum, matrix)) == 1
    assert all(sum(row) == F(1, 24) for row in matrix)
    assert all(sum(matrix[i][j] for i in range(24)) == F(1, 24) for j in range(24))
    assert all(matrix[i][i] == 0 for i in range(24))
    assert sum(matrix[i][j] for i in range(24) for j in range(24) if i // 8 == j // 8) == same


def test_rank_formula_matches_exhaustive_two_block_shuffles():
    # Full enumeration of block order and every within-block permutation for
    # a four-check law, independent of the closed-form rank expression.
    law = {((0, 1), (2, 3)): F(1, 3), ((0, 2), (1, 3)): F(2, 3)}
    matrix = [[F(0) for _ in range(4)] for _ in range(4)]
    for blocks, mass in law.items():
        for block_order in permutations(range(2)):
            for a in permutations(blocks[block_order[0]]):
                for b in permutations(blocks[block_order[1]]):
                    order = a + b
                    matrix[order.index(0)][order.index(1)] += mass / 8
    assert matrix == [[rank_pair_probability(F(1, 3), i, j, q=2, width=2)
                       for j in range(4)] for i in range(4)]


@pytest.mark.parametrize('name', ['P', 'Q'])
def test_hypergeometric_full_tree_price_matches_every_small_allocation(name, laws, small_lifts):
    # Mixed original/filler coverages test more than the two easy embedded trees.
    trees = [((0, 1, 2, 3), (4, 5, 6, 7), (8, 9, 10, 11)),
             (((0, 1), 2, 3, 4), (5, 6, 7, 8), (9, 10, 11)),
             (tuple(range(6)), tuple(range(6, 12)))]
    for tree in trees:
        brute = sum(mass * literal_cost(tree, tuple(i for b in blocks for i in b), width=4)
                    for blocks, mass in small_lifts[name].items())
        assert padded_tree_cost(tree, laws[name], width=4) == brute


@pytest.mark.parametrize('header,slot', [(512, 320), (3, 2), (8, 5), (82, 50)])
def test_embedded_candidate_gap_is_preserved_at_multiple_admissible_prices(header, slot, laws):
    trees = embedded_trees()
    p = {key: padded_tree_cost(tree, laws['P'], header=header, slot=slot) for key, tree in trees.items()}
    q = {key: padded_tree_cost(tree, laws['Q'], header=header, slot=slot) for key, tree in trees.items()}
    assert p['flat'] - p['group'] == F(28 * slot - 17 * header, 8) > 0
    assert q['group'] - q['flat'] == F(11 * header - 16 * slot, 5) > 0


def test_actual_fixed_eight_batching_and_layout_scorer_on_complete_sequences(laws):
    from hact.tree import Node
    from ichact.frontier import completion_waves
    from ichact.layout import Layout
    def node(tree):
        if type(tree) is int:
            return Node(tree, tree)
        children = tuple(node(child) for child in tree)
        return Node(children[0].lo, children[-1].hi, children)
    trees = embedded_trees()
    layouts = {key: Layout(tuple(f'g{i}' for i in range(24)), tuple(range(24)), node(tree))
               for key, tree in trees.items()}
    checked = 0
    for law in laws.values():
        for blocks in law:
            for filler_order in (tuple(range(6, 24)), tuple(reversed(range(6, 24)))):
                for perm in permutations(range(3)):
                    order = complete_order(blocks, filler_order=filler_order, block_order=perm)
                    waves = completion_waves(order, set())  # actual width-eight helper
                    assert list(map(len, waves)) == [8, 8, 8]
                    assert sorted(x for wave in waves for x in wave) == list(range(24))
                    for key, layout in layouts.items():
                        assert layout.cost(waves) == literal_cost(trees[key], order)
                    delta = layouts['group'].cost(waves) - layouts['flat'].cost(waves)
                    direct = source_tree_cost(((0, 1, 2, 3), 4, 5), {blocks: F(1)}) - source_tree_cost(tuple(range(6)), {blocks: F(1)})
                    assert delta == direct
                    checked += 1
    assert checked == 600


def test_invalid_or_incomplete_lifts_are_rejected(laws):
    with pytest.raises(ValueError):
        lifted_moments(laws['P'], width=3)
    with pytest.raises(ValueError):
        validate_law({((0, 1, 2, 3), (4,), (4,)): F(1)}, 6, 3)
    with pytest.raises(ValueError):
        validate_law({((0, 1, 2, 3), (4,), (5,)): F(1, 2)}, 6, 3)
    with pytest.raises(ValueError):
        complete_order(((0, 1, 2, 3), (4,), (5,)), filler_order=range(6, 23))


@pytest.fixture(scope='module')
def report():
    return json.loads(json.dumps(build_report()))


def test_committed_certificate_matches_exact_recomputation(report):
    assert json.loads(RESULT.read_text()) == report
    assert verify_certificate(report)
    assert report['regret_wrong_choice'] == {'P': '32', 'Q': '512/5'}
    assert report['randomized_minimax_regret'] == '512/21'
    assert report['optimal_group_probability'] == '5/21'
    assert report['global_24_leaf_optimality_claimed'] is False


@pytest.mark.parametrize('corruption', ['moments', 'cost', 'scope', 'rank', 'consistent_wrong_rank',
                                      'source_probability', 'model', 'minimax', 'registry'])
def test_corrupted_numeric_or_scope_certificates_fail_closed(report, corruption):
    altered = deepcopy(report)
    if corruption == 'moments':
        altered['same_wave_moments']['P'][0][6] = '1/4'
    elif corruption == 'cost':
        altered['expected_total_padded_bytes']['Q']['group'] = str(F(altered['expected_total_padded_bytes']['Q']['group']) + 1)
    elif corruption == 'scope':
        altered['global_24_leaf_optimality_claimed'] = True
    elif corruption == 'rank':
        altered['bivariate_rank_classes']['G-G']['per_ordered_rank_pair_different_batches'] = '1/384'
    elif corruption == 'consistent_wrong_rank':
        altered['bivariate_rank_classes']['G-G'] = {
            'same_wave': '1/2',
            'per_ordered_distinct_rank_pair_same_batch': str(rank_pair_probability(F(1, 2), 0, 1)),
            'per_ordered_rank_pair_different_batches': str(rank_pair_probability(F(1, 2), 0, 8))}
    elif corruption == 'source_probability':
        altered['source_laws']['P'][0]['probability'] = '1/2'
    elif corruption == 'model':
        altered['cost_model']['include_cold_build'] = False
    elif corruption == 'minimax':
        altered['randomized_minimax_regret'] = '32'
    else:
        altered['complete_checks'] = 23
    with pytest.raises(ValueError):
        verify_certificate(altered)
