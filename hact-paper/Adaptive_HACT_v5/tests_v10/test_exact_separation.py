"""Independent enumeration and analytical checks for the all-tree reference."""

from functools import lru_cache
from itertools import product
import json

import pytest

from experiments_v10.exact_separation import RESULT, build_report, moments, partitions, solve, tree_cost


@lru_cache(maxsize=None)
def explicit_trees(leaves, fanout):
    """Independent restricted-growth-string partitions, then literal trees."""
    if len(leaves) == 1:
        return (leaves[0],)
    groups = [[leaves[0]]]
    results = []

    def extend(position):
        if position == len(leaves):
            if len(groups) >= 2:
                children = [explicit_trees(tuple(group), fanout) for group in groups]
                results.extend(tuple(combo) for combo in product(*children))
            return
        value = leaves[position]
        for group in groups:
            group.append(value)
            extend(position + 1)
            group.pop()
        if len(groups) < fanout:
            groups.append([value])
            extend(position + 1)
            groups.pop()

    extend(1)
    return tuple(results)


def literal_cost(tree, events):
    # Independent set-based cost evaluator, rather than integer-mask DP.
    if isinstance(tree, int):
        return {tree}, 0
    covers, costs = zip(*(literal_cost(child, events) for child in tree))
    covered = set().union(*covers)
    return covered, sum(costs) + (512 + 320 * len(tree)) * sum(bool(covered & e) for e in events)


@pytest.mark.parametrize("n,fanout", [(2, 2), (3, 2), (4, 3), (5, 3)])
def test_subset_dp_matches_independent_literal_tree_enumeration(n, fanout):
    events = [{0}, set(range(1, n)), {n - 1}, {0, n - 1}]
    masks = [sum(1 << i for i in e) for e in events]
    all_trees = explicit_trees(tuple(range(n)), fanout)
    direct = [literal_cost(tree, events)[1] for tree in all_trees]
    result = solve(n, masks, fanout=fanout)
    assert result["cost_numerator"] == min(direct)
    assert result["optimal_tree_count"] == direct.count(min(direct))


def test_partitions_are_complete_unique_and_disjoint():
    # Bell numbers, plus coverage and uniqueness independent of ordering.
    for n, bell in enumerate((1, 1, 2, 5, 15, 52, 203)):
        parts = partitions((1 << n) - 1)
        assert len(parts) == bell
        assert len({tuple(sorted(p)) for p in parts}) == bell
        for p in parts:
            assert sum(p) == (1 << n) - 1
            assert all(a & b == 0 for i, a in enumerate(p) for b in p[i + 1:])


def test_global_optima_are_incompatible_despite_identical_pairwise_moments():
    report = build_report()
    p_events, q_events = report["distributions_as_uniform_bitmasks"].values()
    assert moments(9, p_events) == moments(9, q_events)
    for installations in (0, 1):
        p = report["installation_cases"][str(installations)]["P"]
        q = report["installation_cases"][str(installations)]["Q"]
        assert int(p["expected_bytes"]) == 3856 + installations * 4224
        assert int(q["expected_bytes"]) == 3936 + installations * 4224
        assert p["optimal_tree_count"] == 1
        assert q["optimal_tree_count"] == 3
        assert all(7 in children for children in p["optimal_root_partitions"])
        assert all(any(mask in children for mask in (3, 5, 6)) for children in q["optimal_root_partitions"])
        assert set(map(tuple, p["optimal_root_partitions"])).isdisjoint(map(tuple, q["optimal_root_partitions"]))
        assert int(p["cost_of_Q_optimal_tree"]) > int(p["expected_bytes"])
        assert int(q["cost_of_P_optimal_tree"]) > int(q["expected_bytes"])


def test_empty_events_and_overlapping_tree_rejected():
    with pytest.raises(ValueError):
        solve(9, [])
    with pytest.raises(ValueError):
        tree_cost([0, [0, 1]], [3])


def test_committed_witness_recomputes_exactly():
    assert json.loads(RESULT.read_text()) == build_report()
