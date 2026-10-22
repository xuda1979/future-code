"""Bounded full-wave topology refinement with a fixed semantic/display order.

The historical practical compiler is unchanged. This module fits maximal,
disjoint incumbent subtrees containing at most ``max_subtree_leaves`` leaves
with the existing alphabetic dynamic program. Training costs include one cold
build per episode by default. Only strictly cheaper subtrees replace their
incumbents; a separate validation set selects from the resulting catalogue.

This is local tree-shape optimization using complete completion sets, not a
global tree/permutation optimum or an attribution of gains to higher-order
statistics. The DP uses float64; integer objective checks enforce monotonicity
of every accepted replacement even if a numerical tie is resolved differently.
"""
from __future__ import annotations

from bisect import bisect_left, bisect_right
from collections.abc import Sequence
import time

import numpy as np

from hact.tree import CostModel, Node, activation_matrix, optimize
from ichact.layout import Layout, select_validation
from ichact.practical import practical_catalogue


def _validated_episodes(episodes, n):
    if (not isinstance(episodes, Sequence) or isinstance(episodes, (str, bytes))
            or not len(episodes)):
        raise ValueError("nonempty training/validation episodes required")
    result = []
    for episode in episodes:
        if not isinstance(episode, Sequence) or isinstance(episode, (str, bytes)):
            raise ValueError("episode must be a sequence of completion waves")
        waves = []
        for wave in episode:
            if not isinstance(wave, Sequence) or isinstance(wave, (str, bytes)):
                raise ValueError("completion wave must be a sequence of canonical indices")
            if any(type(i) is not int or not 0 <= i < n for i in wave):
                raise ValueError("unknown canonical obligation index")
            waves.append(tuple(sorted(set(wave))))
        result.append(tuple(waves))
    return tuple(result)


def _shift(tree, offset):
    return Node(tree.lo + offset, tree.hi + offset,
                tuple(_shift(child, offset) for child in tree.children))


def _objective(tree, episodes, model, initial):
    """Integer numerator over all episodes; one initial build per episode."""
    result = 0
    for node in tree.walk():
        if node.leaf:
            continue
        hits = len(episodes) if initial else 0
        for episode in episodes:
            for wave in episode:
                position = bisect_left(wave, node.lo)
                hits += position < len(wave) and wave[position] <= node.hi
        result += model.packet_bytes(len(node.children)) * hits
    return result


def refine_fullwave(layout, training, *, max_subtree_leaves=32, initial=True):
    """Refine fixed-order, disjoint subtrees using training episodes only.

    Maximal existing nonleaf subtrees of size at most the budget are solved
    once, so all ancestors and all other subtrees remain unchanged. At most
    ``O(n*s**2)`` DP work and ``O(s**2*b)`` peak DP memory are used, apart from
    input projection/scoring; ``s`` is the cap and ``b`` the model fanout.
    The caller must account for measured compilation time separately from
    padded representation bytes; neither is a proxy for network latency.
    """
    started = time.perf_counter()
    if not isinstance(layout, Layout):
        raise ValueError("validated Layout required")
    if type(max_subtree_leaves) is not int or max_subtree_leaves < 2:
        raise ValueError("subtree budget must be an integer of at least two")
    if type(initial) is not bool:
        raise ValueError("initial must be a boolean")
    episodes = _validated_episodes(training, len(layout.registry))
    inverse = {semantic: p for p, semantic in enumerate(layout.order)}
    positional = tuple(tuple(tuple(sorted(inverse[i] for i in wave))
                             for wave in episode) for episode in episodes)
    before = _objective(layout.tree, positional, layout.model, initial)
    attempted = replaced = largest = 0
    decisions = []

    def visit(node):
        nonlocal attempted, replaced, largest
        if node.leaf:
            return node
        count = node.hi - node.lo + 1
        if count > max_subtree_leaves:
            children = tuple(visit(child) for child in node.children)
            return node if children == node.children else Node(node.lo, node.hi, children)
        attempted += 1
        largest = max(largest, count)
        local = tuple(tuple(tuple(p - node.lo for p in
                           wave[bisect_left(wave, node.lo):bisect_right(wave, node.hi)])
                            for wave in episode) for episode in positional)
        waves = [wave for episode in local for wave in episode]
        # Scaling preserves the minimizer. Counts include empty episodes, so
        # their cold-build price cannot disappear when a projection is empty.
        weights = np.triu(np.full((count, count), len(local) if initial else 0,
                                  dtype=np.float64))
        if waves:
            weights += activation_matrix(waves, count) * len(waves)
        scale = float(weights.max())
        old_cost = _objective(node, positional, layout.model, initial)
        if scale == 0:
            decisions.append({"lo": node.lo, "hi": node.hi, "replaced": False,
                              "before": old_cost, "after": old_cost})
            return node
        tree, _ = optimize(weights / scale, layout.model)
        proposal = _shift(tree, node.lo)
        new_cost = _objective(proposal, positional, layout.model, initial)
        accepted = new_cost < old_cost
        decisions.append({"lo": node.lo, "hi": node.hi, "replaced": accepted,
                          "before": old_cost, "after": new_cost if accepted else old_cost})
        if accepted:
            replaced += 1
            return proposal
        return node

    tree = visit(layout.tree)
    result = layout if tree == layout.tree else Layout(layout.registry, layout.order,
                                                       tree, layout.model)
    after = _objective(result.tree, positional, layout.model, initial)
    if after > before:
        raise AssertionError("bounded refinement increased its training objective")
    return result, {"method": "bounded_fullwave_subtree_dp",
                    "max_subtree_leaves": max_subtree_leaves,
                    "largest_subproblem": largest, "subproblems": attempted,
                    "subtrees_replaced": replaced,
                    "training_episodes": len(episodes),
                    "training_total_before": before, "training_total_after": after,
                    "initial_build_per_episode": initial,
                    "elapsed_seconds": time.perf_counter() - started,
                    "subtree_decisions": decisions,
                    "scope": "fixed-order existing-subtree topology refinement; float64 DP",
                    "attribution": "tree-shape effect; higher-order causality not isolated"}


def select_fullwave(registry, training, validation, *, incumbent=None,
                    max_subtree_leaves=32, fanout=8, model=CostModel()):
    """Training-fitted catalogue, separate validation, incumbent-favoring ties.

    The original and pairwise-order compact layouts and their bounded refinements
    use the same registry and packet contract. This routine performs advisory
    selection, never authorization or automatic migration. The validation score
    is empirical padded bytes; no out-of-sample or wall-time gain is guaranteed.
    """
    started = time.perf_counter()
    ids = tuple(registry)
    train = _validated_episodes(training, len(ids))
    valid = _validated_episodes(validation, len(ids))
    base = practical_catalogue(ids, train, incumbent=incumbent, fanout=fanout, model=model)
    catalogue = dict(base)
    details = {}
    for name, layout in base.items():
        refined, info = refine_fullwave(layout, train,
                                       max_subtree_leaves=max_subtree_leaves)
        details[name] = info
        if all(refined.uid != value.uid for value in catalogue.values()):
            catalogue[name + "_fullwave"] = refined
    selected, scores = select_validation(catalogue, valid)
    return catalogue[selected], {"selected": selected, "scores": scores,
                                 "candidate_ids": {k: v.uid for k, v in catalogue.items()},
                                 "cost_metric": "padded_certificate_bytes",
                                 "max_subtree_leaves": max_subtree_leaves,
                                 "refinements": details,
                                 "compile_seconds": time.perf_counter() - started,
                                 "scope": "validation-selected topology/order catalogue"}
