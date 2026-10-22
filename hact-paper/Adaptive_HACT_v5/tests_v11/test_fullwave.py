"""Contract tests for training-only, bounded full-wave topology refinement."""

from functools import lru_cache
from itertools import combinations, product

import pytest

from hact.tree import CostModel, Node, validate_tree
from ichact.fullwave import refine_fullwave, select_fullwave
from ichact.layout import Layout, jaccard_affinity
from ichact.practical import balanced_layout


@lru_cache(maxsize=None)
def _literal_trees(lo, hi, fanout):
    """All ordered trees, from independent literal interval compositions."""
    if lo == hi:
        return (Node(lo, hi),)
    trees = []
    for arity in range(2, min(fanout, hi - lo + 1) + 1):
        for cuts in combinations(range(lo + 1, hi + 1), arity - 1):
            starts, stops = (lo, *cuts), (*[c - 1 for c in cuts], hi)
            choices = [_literal_trees(a, b, fanout) for a, b in zip(starts, stops)]
            trees.extend(Node(lo, hi, children) for children in product(*choices))
    return tuple(trees)


def _literal_cost(tree, order, episodes, model, initial=True):
    total = 0
    for node in tree.walk():
        if not node.children:
            continue
        # Literal sets, independently of the implementation's bitmask scoring.
        covered = {order[p] for p in range(node.lo, node.hi + 1)}
        hits = (len(episodes) if initial else 0) + sum(
            bool(covered.intersection(wave)) for episode in episodes for wave in episode
        )
        total += (model.header + len(node.children) * model.card) * hits
    return total


@pytest.mark.parametrize("n,fanout", [(2, 2), (3, 2), (4, 3), (5, 3), (6, 3)])
@pytest.mark.parametrize("initial", [True, False])
def test_whole_tree_refinement_attains_literal_ordered_optimum(n, fanout, initial):
    model = CostModel(header=3, card=2, cap=3 + fanout * 2)
    ids = tuple(f"g{i}" for i in range(n))
    order = tuple(reversed(range(n)))
    episodes = [[[0], [0, 1]], [[n - 1]], [[]], [[0, n - 1]]]
    base = balanced_layout(ids, order, fanout=fanout, model=model)
    result, info = refine_fullwave(base, episodes, max_subtree_leaves=n, initial=initial)
    best = min(_literal_cost(t, order, episodes, model, initial)
               for t in _literal_trees(0, n - 1, fanout))
    assert _literal_cost(result.tree, order, episodes, model, initial) == best
    assert info["training_total_after"] == best
    assert info["training_total_before"] == _literal_cost(base.tree, order, episodes, model, initial)
    assert info["training_total_after"] <= info["training_total_before"]
    assert result.registry == base.registry and result.order == base.order
    assert result.model == base.model


def test_bounded_subtrees_preserve_global_order_and_never_increase_training_cost():
    ids = tuple(f"g{i}" for i in range(137))
    base = balanced_layout(ids, fanout=8)
    training = [[[i, (i + 1) % 137]] for i in range(60)]
    result, info = refine_fullwave(base, training, max_subtree_leaves=32)
    validate_tree(result.tree, len(ids), result.model)
    assert result.order == base.order
    assert result.tree.lo == 0 and result.tree.hi == 136
    assert info["largest_subproblem"] <= 32
    assert info["subproblems"] > 1
    assert info["training_total_after"] <= info["training_total_before"]
    # Even when no work exists within a subtree, its initial build is priced.
    assert info["training_total_after"] == sum(result.cost(ep) for ep in training)
    assert info["elapsed_seconds"] >= 0


def test_tie_preserves_the_original_tree_and_layout_identity():
    base = balanced_layout(tuple(f"g{i}" for i in range(8)))
    result, info = refine_fullwave(base, [[list(range(8))]], max_subtree_leaves=32)
    assert result is base
    assert info["subtrees_replaced"] == 0
    assert info["training_total_before"] == info["training_total_after"]


def test_no_waves_with_no_initial_build_cannot_fabricate_a_gain():
    base = balanced_layout(tuple(f"g{i}" for i in range(9)))
    result, info = refine_fullwave(base, [[], [[]]], initial=False)
    assert result is base
    assert info["training_total_after"] == 0


def test_singleton_registry_and_all_empty_training_episodes_are_valid():
    base = balanced_layout(("g0",))
    result, info = refine_fullwave(base, [[], [[]]])
    assert result is base
    assert info["training_total_before"] == info["training_total_after"] == 0
    assert info["subproblems"] == 0


@pytest.mark.parametrize("training", [[], [[[-1]]], [[[9]]], [[[True]]], [[[1.0]]], [None], [[None]]])
def test_invalid_training_is_rejected_even_if_a_subtree_is_untouched(training):
    base = balanced_layout(tuple(f"g{i}" for i in range(9)))
    with pytest.raises(ValueError):
        refine_fullwave(base, training, max_subtree_leaves=2)


@pytest.mark.parametrize("cap", [0, 1, True, 3.0, None])
def test_invalid_refinement_budget_is_rejected(cap):
    base = balanced_layout(tuple(f"g{i}" for i in range(9)))
    with pytest.raises(ValueError):
        refine_fullwave(base, [[[0]]], max_subtree_leaves=cap)


def test_invalid_initial_flag_is_rejected():
    base = balanced_layout(("g",))
    with pytest.raises(ValueError):
        refine_fullwave(base, [[[]]], initial=1)


def test_duplicate_ids_in_a_wave_have_set_semantics():
    base = balanced_layout(tuple(f"g{i}" for i in range(9)))
    one, a = refine_fullwave(base, [[[0, 1]]])
    two, b = refine_fullwave(base, [[[0, 0, 1, 1]]])
    assert one.uid == two.uid
    assert a["training_total_before"] == b["training_total_before"]
    assert a["training_total_after"] == b["training_total_after"]


def test_validation_tie_keeps_incumbent_first_without_heldout_access():
    ids = tuple(f"g{i}" for i in range(9))
    incumbent = balanced_layout(ids)
    result, report = select_fullwave(ids, [[[0]]], [[list(range(9))]], incumbent=incumbent)
    # The full tree build can differ; a selected candidate must minimize the
    # stated validation cost, and dictionary ties favor the incumbent.
    scores = report["scores"]
    assert scores[report["selected"]] == min(scores.values())
    if scores["incumbent"] == min(scores.values()):
        assert result.uid == incumbent.uid and report["selected"] == "incumbent"
    assert list(report["candidate_ids"])[0] == "incumbent"
    assert report["cost_metric"] == "padded_certificate_bytes"
    assert report["max_subtree_leaves"] == 32


def test_single_candidate_catalogue_still_validates_validation_ids():
    with pytest.raises(ValueError):
        select_fullwave(("g",), [[[]]], [[[1]]])


def test_foreign_incumbent_and_empty_validation_are_rejected():
    with pytest.raises(ValueError):
        select_fullwave(("a",), [[[]]], [[[]]], incumbent=balanced_layout(("b",)))
    with pytest.raises(ValueError):
        select_fullwave(("a",), [[[]]], [])


def test_refinement_trains_on_complete_episodes_not_only_nonempty_projections():
    ids = tuple(f"g{i}" for i in range(9))
    base = balanced_layout(ids)
    episodes = [[[0]], [[]], [], [[8]]]
    result, info = refine_fullwave(base, episodes)
    assert info["training_episodes"] == 4
    assert info["training_total_after"] == _literal_cost(result.tree, result.order, episodes, result.model)


def test_fullwave_compiler_distinguishes_the_pairwise_identical_analytical_witness():
    # The same nine-check parity witness as V10, not a new empirical dataset.
    anchors = list(range(3, 9))
    p = [[anchors + odd] for odd in ([], [0, 1], [0, 2], [1, 2])]
    q = [[anchors + odd] for odd in ([0], [1], [2], [0, 1, 2])]
    assert (jaccard_affinity(p, 9) == jaccard_affinity(q, 9)).all()
    original = balanced_layout(tuple(f"g{i}" for i in range(9)))
    left, a = refine_fullwave(original, p)
    right, b = refine_fullwave(original, q)
    assert left.order == right.order == original.order
    # Independent all-labeled-tree reference in V10 proves these global optima;
    # this fixed-order test checks the new implementation reaches them.
    assert a["training_total_after"] == 4 * 8080
    assert b["training_total_after"] == 4 * 8160
    assert left.uid != right.uid


def test_public_literal_reference_prices_initial_and_empty_wave_correctly():
    from experiments_v11.public_compiler_study import packet_bytes_reference
    layout = balanced_layout(("a", "b", "c")).to_dict()
    assert packet_bytes_reference(layout, [[[0], [1, 2]], [[], [2]]]) == [3 * 1472, 2 * 1472]


def test_public_literal_reference_detects_tampered_tree():
    from experiments_v11.public_compiler_study import packet_bytes_reference
    value = balanced_layout(("a", "b", "c")).to_dict()
    value["tree"]["children"][1]["lo"] = 0
    with pytest.raises(ValueError):
        packet_bytes_reference(value, [[[0]]])


def test_public_literal_reference_rejects_foreign_completion_indices():
    from experiments_v11.public_compiler_study import packet_bytes_reference
    with pytest.raises(ValueError):
        packet_bytes_reference(balanced_layout(("a", "b")).to_dict(), [[[2]]])


def test_public_fitting_uses_only_training_and_validation_runs(monkeypatch):
    from experiments_v11 import public_compiler_study as study
    calls = []

    def observed(project, run):
        calls.append(run)
        assert run in (0, 1, 2), "held-out run opened during fitting"
        return {"registry": tuple(f"g{i}" for i in range(9)),
                "episode": [[0, 1, 2, 3, 4, 5, 6, 7], [8]],
                "report": {k: "stable" for k in ("snapshot", "checker", "environment", "registry_hash")},
                "status_counts": {"PASS": 9, "FAIL": 0, "UNKNOWN": 0}, "provenance": {}}

    monkeypatch.setattr(study, "_run", observed)
    fit = study._fit_payload("example")
    assert calls == [0, 1, 2]
    assert fit["heldout_opened"] is False
    assert fit["selected"]["fullwave32"] == "original_compact"
    assert fit["selected"]["fullwave64"] == "original_compact"


def test_public_identity_check_rejects_registry_drift():
    from experiments_v11.public_compiler_study import _same_identity
    with pytest.raises(ValueError, match="registry changed"):
        _same_identity([{"registry": ("a",)}, {"registry": ("b",)}])


def test_public_evaluation_requires_all_fitting_to_be_frozen(monkeypatch, tmp_path):
    from experiments_v11 import public_compiler_study as study
    monkeypatch.setattr(study, "OUT", tmp_path)
    with pytest.raises(RuntimeError, match="freeze"):
        study.evaluate_projects()


def test_public_large_registry_refuses_dense_allocation_and_retains_every_obligation(monkeypatch):
    from experiments_v11 import public_compiler_study as study
    n = study.CONTRACT["max_dense_registry"] + 1

    def observed(project, run):
        return {"registry": tuple(f"g{i}" for i in range(n)), "episode": [[0, n - 1]],
                "report": {k: "stable" for k in ("snapshot", "checker", "environment", "registry_hash")},
                "status_counts": {"PASS": 1, "FAIL": 1, "UNKNOWN": 0}, "provenance": {}}

    def forbidden(*args, **kwargs):
        pytest.fail("dense affinity allocated despite resource refusal")

    monkeypatch.setattr(study, "_run", observed)
    monkeypatch.setattr(study, "jaccard_affinity", forbidden)
    result = study._fit_payload("large")
    assert result["status"] == "UNKNOWN" and result["optimization_available"] is False
    assert len(result["fallback_layout"]["registry"]) == n
    assert result["fallback_train_per_run_bytes"][0] > 0
