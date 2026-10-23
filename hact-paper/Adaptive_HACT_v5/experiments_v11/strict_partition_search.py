"""Exploratory exact-checkable search for strict-epoch pairwise separation.

Every observation partitions all checks into the same number of nonempty
completion waves. Discovery uses a small LP; accepted witnesses must pass
integer rational moment and all-tree cost checks. This is mathematical search,
not software-workload evidence or a registered empirical experiment.
"""
from __future__ import annotations

import argparse
from fractions import Fraction
from functools import lru_cache
from itertools import combinations
import json
from pathlib import Path

import numpy as np


@lru_cache(maxsize=None)
def partitions(labels):
    if not labels:
        return ((),)
    groups = [[labels[0]]]
    result = []

    def visit(index):
        if index == len(labels):
            result.append(tuple(tuple(g) for g in groups))
            return
        for group in groups:
            group.append(labels[index]); visit(index + 1); group.pop()
        groups.append([labels[index]]); visit(index + 1); groups.pop()

    visit(1)
    return tuple(result)


def data(n, q):
    source = tuple(p for p in partitions(tuple(range(n))) if len(p) == q)
    moments = np.array([[1] * len(source)] + [
        [int(any(i in block and j in block for block in p)) for p in source]
        for i, j in combinations(range(n), 2)], dtype=float)
    subsets = (None, *(frozenset(g) for k in range(2, n) for g in combinations(range(n), k)))
    costs = []
    for group in subsets:
        if group is None:
            costs.append([(512 + 320 * n) * (q + 1)] * len(source))
        else:
            k = len(group)
            root = (512 + 320 * (n - k + 1)) * (q + 1)
            packet = 512 + 320 * k
            costs.append([root + packet * (1 + sum(bool(group.intersection(block)) for block in p))
                          for p in source])
    return source, moments, subsets, np.asarray(costs, dtype=float)


def lp_pair(n, q, left, right):
    from scipy.optimize import linprog
    source, moments, groups, costs = data(n, q)
    size, trees = len(source), len(costs)
    # At n<=7 the reduced candidates are verified against a separate full
    # subset/tree DP below, so this LP is only a witness discovery mechanism.
    equal = np.column_stack((moments, -moments, np.zeros(len(moments))))
    equal = np.row_stack((equal, np.r_[np.ones(size), np.zeros(size + 1)]))
    targets = np.r_[np.zeros(len(moments)), 1.0]
    rows = []
    for index in range(trees):
        if index != left:
            rows.append(np.r_[costs[left] - costs[index], np.zeros(size), 1.0])
        if index != right:
            rows.append(np.r_[np.zeros(size), costs[right] - costs[index], 1.0])
    objective = np.r_[np.zeros(size * 2), -1.0]
    result = linprog(objective, A_ub=np.asarray(rows), b_ub=np.zeros(len(rows)),
                     A_eq=equal, b_eq=targets, bounds=[(0, None)] * (2 * size) + [(None, None)],
                     method="highs")
    return source, groups, costs, result


def _rational(values):
    return tuple(Fraction(float(v)).limit_denominator(1000000) if abs(v) > 1e-10 else Fraction(0)
                 for v in values)


def exact_check(n, q, source, probabilities, *, fanout=8):
    """Independent all-labeled-tree DP over literal set partitions."""
    if sum(probabilities) != 1 or any(value < 0 for value in probabilities):
        raise ValueError("rational probabilities do not form a distribution")
    support = tuple((p, w) for p, w in zip(source, probabilities) if w)

    @lru_cache(maxsize=None)
    def solve(labels):
        if len(labels) == 1:
            return Fraction(0), 1, labels[0], ()
        covered = frozenset(labels)
        weight = 1 + sum(w * sum(bool(covered.intersection(block)) for block in partition)
                         for partition, w in support)
        best, ways, tree, roots = None, 0, None, []
        for blocks in partitions(labels):
            if not 2 <= len(blocks) <= fanout:
                continue
            children = [solve(block) for block in blocks]
            cost = (512 + 320 * len(blocks)) * weight + sum(child[0] for child in children)
            count = 1
            for child in children:
                count *= child[1]
            if best is None or cost < best:
                best, ways, tree, roots = cost, count, tuple(child[2] for child in children), [blocks]
            elif cost == best:
                ways += count
                roots.append(blocks)
        return best, ways, tree, tuple(roots)

    best, count, tree, roots = solve(tuple(range(n)))
    return {"cost": str(best), "optimal_tree_count": count, "tree": tree,
            "optimal_root_partitions": roots, "subsets_solved": solve.cache_info().currsize}


def moments_exact(n, source, probabilities):
    return tuple(sum(w * any(i in block and j in block for block in partition)
                     for partition, w in zip(source, probabilities))
                 for i, j in combinations(range(n), 2))


def search():
    tried = []
    for n, q in ((5, 2), (5, 3), (6, 2), (6, 3), (7, 2), (7, 3)):
        source, moments, groups, costs = data(n, q)
        candidates = [i for i, group in enumerate(groups) if group is not None and len(group) in (4, 5)]
        # Symmetry fixes the left grouped subset to the first labels.
        lefts = [i for i in candidates if groups[i] == frozenset(range(len(groups[i])))]
        rights = [0] + candidates
        for left in lefts:
            seen_types = set()
            for right in rights:
                if right == left:
                    continue
                kind = (0, 0) if right == 0 else (len(groups[right]), len(groups[left] & groups[right]))
                if kind in seen_types:
                    continue
                seen_types.add(kind)
                source, groups, costs, result = lp_pair(n, q, left, right)
                margin = None if not result.success else float(result.x[-1])
                print("strict search", n, q, sorted(groups[left]),
                      None if right == 0 else sorted(groups[right]), margin, flush=True)
                tried.append({"n": n, "q": q, "left": sorted(groups[left]),
                              "right": None if right == 0 else sorted(groups[right]), "lp_margin": margin})
                if result.success and margin > 1e-7:
                    p, r = _rational(result.x[:len(source)]), _rational(result.x[len(source):2 * len(source)])
                    if sum(p) != 1 or sum(r) != 1 or moments_exact(n, source, p) != moments_exact(n, source, r):
                        print("rationalization rejected", flush=True)
                        continue
                    checks = {"P": exact_check(n, q, source, p), "Q": exact_check(n, q, source, r)}
                    roots_p = {str(value) for value in checks["P"]["optimal_root_partitions"]}
                    roots_q = {str(value) for value in checks["Q"]["optimal_root_partitions"]}
                    if roots_p & roots_q:
                        print("global optimum sets not proved disjoint", flush=True)
                        continue
                    return {"status": "WITNESS", "n": n, "waves_per_epoch": q,
                            "prices": {"header": 512, "slot": 320, "fanout": 8},
                            "scope": "complete strict partition per epoch, one cold build, all shapes and permutations",
                            "distributions": {label: [{"partition": partition, "probability": str(weight)}
                                                        for partition, weight in zip(source, values) if weight]
                                              for label, values in (("P", p), ("Q", r))},
                            "pairwise_moments": [str(value) for value in moments_exact(n, source, p)],
                            "reference": checks, "searches": tried,
                            "interpretation": "constructed analytical witness, not empirical improvement"}
    return {"status": "NO_WITNESS", "searches": tried,
            "interpretation": "bounded search null; no nonexistence theorem claimed"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = search()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
