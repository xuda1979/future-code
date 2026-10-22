from fractions import Fraction
from itertools import permutations, product
from math import factorial

import pytest

from hact.tree import CostModel
from ichact.exchangeable import batch_sizes, cardinality_weights, optimize_exchangeable
from ichact.layout import Layout
from experiments_v14.exchangeable_study import permutation_hit_numerators, literal_expected_numerator, literal_from_layout
from experiments_v11.strict_partition_witness import literal_trees


def compositions(n):
    if n == 0:
        yield ()
    for first in range(1, n+1):
        for rest in compositions(n-first):
            yield (first, *rest)


def test_every_small_batch_composition_matches_actual_permutations():
    for n in range(1, 7):
        for batches in compositions(n):
            hits, denominator, _ = permutation_hit_numerators(n, batches)
            for initial in (False, True):
                weights = cardinality_weights(n, batches, initial=initial)
                for size in range(1, n+1):
                    for mask in range(1, 1 << n):
                        if mask.bit_count() == size:
                            assert weights[size] == int(initial) + Fraction(hits[mask], denominator)


@pytest.mark.parametrize('header,slot', [(1, 1), (512, 320), (17, 2)])
def test_small_global_optima_across_prices_arities_and_general_batch_sizes(header, slot):
    n = 5
    trees = literal_trees(tuple(range(n)))
    for batches in compositions(n):
        hits, denominator, _ = permutation_hit_numerators(n, batches)
        for fanout in range(2, n+1):
            model = CostModel(header, slot, header+fanout*slot)
            rows = [literal_expected_numerator(t, hits, denominator, model) for t in trees]
            best = Fraction(min(cost for _, cost, arity in rows if arity <= fanout), denominator)
            layout, record = optimize_exchangeable(tuple(map(str, range(n))), batches, model=model)
            assert Fraction(record['expected_padded_epoch_bytes']) == best
            assert Fraction(literal_expected_numerator(literal_from_layout(layout), hits, denominator, model)[1], denominator) == best


def test_global_n_weights_are_not_recomputed_using_local_subtree_size():
    layout, record = optimize_exchangeable(tuple(map(str, range(10))), (8, 2))
    assert Fraction(record['expected_padded_epoch_bytes']) == Fraction(194176, 15)
    weights = cardinality_weights(10, (8, 2))
    assert weights[2] == Fraction(106, 45)


def test_one_batch_objective_is_twice_minimum_construction_and_compact_is_not_always_optimal():
    layout, record = optimize_exchangeable(tuple(map(str, range(10))), (10,))
    # n=10,b=8 needs two internal nodes; their edge-count price is 4544.
    assert Fraction(record['expected_padded_epoch_bytes']) == 9088
    assert sum(not x.leaf for x in layout.tree.walk()) == 2


def test_singleton_batches_ignore_all_leaf_permutations():
    layout, record = optimize_exchangeable(tuple(map(str, range(5))), (1,)*5)
    hits, denominator, _ = permutation_hit_numerators(5, (1,)*5)
    expected = Fraction(record['expected_padded_epoch_bytes'])
    for order in permutations(range(5)):
        other = Layout(layout.registry, order, layout.tree, layout.model)
        assert Fraction(literal_expected_numerator(literal_from_layout(other), hits, denominator, layout.model)[1], denominator) == expected


def test_single_leaf_and_declared_quadratic_state_bound():
    layout, record = optimize_exchangeable(('a',), (1,))
    assert layout.tree.leaf and record['expected_padded_epoch_bytes'] == '0'
    _, large = optimize_exchangeable(tuple(map(str, range(64))), (8,)*8)
    assert large['integer_candidate_comparisons'] <= 8*64*64
    assert large['dp_state_bound'] == 2*9*65+2*65


@pytest.mark.parametrize('batches', [(), (0, 6), (True, 5), (3, 2), (7,), '6'])
def test_invalid_completion_support_rejects(batches):
    with pytest.raises(ValueError):
        optimize_exchangeable(tuple(map(str, range(6))), batches)


def test_invalid_registry_and_admission_reject_without_fitting():
    for ids in [(), ('a', 'a'), ('a', '')]:
        with pytest.raises(ValueError):
            optimize_exchangeable(ids, (len(ids),))
    with pytest.raises(ValueError, match='admission'):
        optimize_exchangeable(('a', 'b'), (2,), max_n=1)


def test_reproducible_integer_tie_resolution():
    a, ar = optimize_exchangeable(tuple(map(str, range(64))), (8,)*8)
    b, br = optimize_exchangeable(tuple(map(str, range(64))), (8,)*8)
    assert a.uid == b.uid and ar == br
