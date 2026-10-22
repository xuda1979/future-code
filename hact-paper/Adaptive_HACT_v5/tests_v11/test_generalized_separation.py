"""Independent exact enumeration of the generalized pairwise-information gap."""
from fractions import Fraction
from itertools import product

import pytest

from experiments_v11.theory_generalization import (
    check_case, distributions, exact_reference, formulas, moment_counts,
)


@pytest.mark.parametrize("b,h,s,construction", [
    (3, 0, 1, 0), (3, 0, 1, Fraction(1, 2)), (3, 0, 1, 2),
    (3, 512, 320, 0), (4, 1, 1, Fraction(1, 2)),
    (5, 10000, 1, 2), (5, 512, 320, Fraction(1, 2)),
])
def test_generalized_formula_matches_independent_all_tree_reference(b, h, s, construction):
    assert check_case(b, h, s, construction)["status"] == "PASS"


def test_defaults_recover_exact_regret_and_mixture():
    case = formulas()
    assert case["P_optimum"] == "3856"
    assert case["Q_optimum"] == "3936"
    assert case["deterministic_minimax_regret"] == "80"
    assert case["randomized_minimax_regret"] == "1440/23"
    assert case["randomized_minimax_triple_probability"] == "5/23"
    assert formulas(construction=1)["P_optimum"] == "8080"
    assert formulas(construction=1)["Q_optimum"] == "8160"


@pytest.mark.parametrize("b", [3, 4, 8, 32])
def test_pairwise_equality_for_each_fanout(b):
    observations = distributions(b)
    assert moment_counts(observations["P"], b + 1) == moment_counts(observations["Q"], b + 1)
    assert all(event for events in observations.values() for event in events)


def test_randomized_minimax_is_sharp_and_construction_independent():
    # A direct two-action game calculation, independent of the formula helper.
    for h, s in product((0, 1, 512, 10000), (1, 320)):
        p_pair_regret = Fraction(s, 4)
        q_triple_regret = Fraction(h + 2 * s, 4)
        q = p_pair_regret / (p_pair_regret + q_triple_regret)
        game_value = p_pair_regret * (1 - q)
        assert game_value == q_triple_regret * q
        for multiplier in (0, Fraction(1, 2), 2):
            case = formulas(8, h, s, multiplier)
            assert Fraction(case["randomized_minimax_triple_probability"]) == q
            assert Fraction(case["randomized_minimax_regret"]) == game_value


@pytest.mark.parametrize("b,h,s,construction", [
    (2, 1, 1, 0), (True, 1, 1, 0), (3, -1, 1, 0),
    (3, 1, 0, 0), (3, 1, -1, 0), (3, 1, 1, -1),
    (3, 1, 1, True),
])
def test_invalid_theorem_parameters_rejected(b, h, s, construction):
    with pytest.raises(ValueError):
        formulas(b, h, s, construction)


def test_reference_refuses_large_or_unknown_universe():
    with pytest.raises(ValueError):
        exact_reference(({0},), n=10, fanout=8, header=512, slot=320)
    with pytest.raises(ValueError):
        exact_reference(({4},), n=4, fanout=3, header=512, slot=320)


def test_small_reference_matches_independently_listed_literal_trees():
    # For four labeled leaves and arities 2..3 there are 25 unordered trees:
    # 4 root/triple trees, 6 root/pair trees, and 15 entirely binary trees.
    from itertools import combinations
    leaves = frozenset(range(4))
    trees = []
    for triple in combinations(range(4), 3):
        trees.append((tuple(triple), next(iter(leaves - set(triple)))))
    for pair in combinations(range(4), 2):
        trees.append((tuple(pair), *sorted(leaves - set(pair))))
    for root_leaf in range(4):
        remainder = leaves - {root_leaf}
        for pair in combinations(sorted(remainder), 2):
            third = next(iter(remainder - set(pair)))
            trees.append((root_leaf, (tuple(pair), third)))
    for pair in combinations(range(1, 4), 1):
        left = (0, pair[0])
        trees.append((left, tuple(sorted(leaves - set(left)))))
    assert len(trees) == 25

    def evaluate(tree, events, h, s, multiplier):
        if isinstance(tree, int):
            return {tree}, Fraction(0)
        covered, cost = set(), Fraction(0)
        for child in tree:
            subset, child_cost = evaluate(child, events, h, s, multiplier)
            assert not covered & subset
            covered.update(subset)
            cost += child_cost
        hit_probability = Fraction(sum(bool(covered & event) for event in events), len(events))
        return covered, cost + (h + s * len(tree)) * (multiplier + hit_probability)

    for h, s, multiplier in ((0, 1, 0), (512, 320, Fraction(1, 2)), (10000, 1, 2)):
        for events in distributions(3).values():
            costs = [evaluate(tree, events, h, s, multiplier)[1] for tree in trees]
            result = exact_reference(events, n=4, fanout=3, header=h, slot=s,
                                     construction=multiplier)
            assert Fraction(result["objective"]) == min(costs)
            assert result["optimal_tree_count_unordered"] == costs.count(min(costs))


def test_wrong_closed_form_cannot_pass_the_reference(monkeypatch):
    import experiments_v11.theory_generalization as theory
    correct_formulas = theory.formulas

    def corrupted(*args, **kwargs):
        result = correct_formulas(*args, **kwargs)
        result["P_optimum"] = str(Fraction(result["P_optimum"]) + 1)
        return result

    monkeypatch.setattr(theory, "formulas", corrupted)
    with pytest.raises(AssertionError):
        theory.check_case(3, 512, 320)
