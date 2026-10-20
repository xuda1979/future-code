"""Exact all-topology reference for the pairwise-identifiability witness.

This deliberately small exponential reference imports no HACT compiler or
cost implementation. All probabilities have denominator len(events); the
dynamic program uses integer numerators, so ties are exact. A partition of a
leaf set enumerates every possible root, and proper child subsets have
already been solved. Child order is immaterial to this objective; every such
tree admits a leaf permutation. This is not the old fixed-topology reference.
"""

import argparse
from fractions import Fraction
from functools import lru_cache
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RESULT = ROOT / "results/v10/pairwise_separation.json"


@lru_cache(maxsize=None)
def partitions(mask):
    """Every unordered set partition, once, using its least element first."""
    if mask == 0:
        return ((),)
    first = mask & -mask
    rest = mask ^ first
    output = []
    subset = rest
    while True:
        block = first | subset
        for tail in partitions(rest ^ subset):
            output.append((block,) + tail)
        if subset == 0:
            break
        subset = (subset - 1) & rest
    return tuple(output)


def solve(n, events, *, fanout=8, header=512, slot=320, installations=0):
    """Minimize installation plus mean refresh cost over ALL labeled trees."""
    if not 1 <= n <= 10 or not 2 <= fanout <= 8:
        raise ValueError("small reference requires 1<=n<=10 and 2<=fanout<=8")
    if header < 0 or slot < 0 or installations not in (0, 1):
        raise ValueError("nonnegative prices and zero/one installation required")
    full = (1 << n) - 1
    if not events or any(not isinstance(e, int) or e < 0 or e > full for e in events):
        raise ValueError("events must be nonempty valid bitmask observations")
    costs, trees, counts, best_roots = {}, {}, {}, {}
    considered = 0
    for mask in sorted(range(1, full + 1), key=lambda m: (m.bit_count(), m)):
        if mask.bit_count() == 1:
            costs[mask], trees[mask], counts[mask] = 0, mask.bit_length() - 1, 1
            best_roots[mask] = []
            continue
        hits = sum(bool(event & mask) for event in events)
        weight = hits + installations * len(events)
        best, tree, count, roots = None, None, 0, []
        for children in partitions(mask):
            arity = len(children)
            if not 2 <= arity <= fanout:
                continue
            considered += 1
            cost = (header + slot * arity) * weight + sum(costs[c] for c in children)
            child_count = 1
            for child in children:
                child_count *= counts[child]
            if best is None or cost < best:
                best, tree, count = cost, [trees[c] for c in children], child_count
                roots = [children]
            elif cost == best:
                count += child_count
                roots.append(children)
        costs[mask], trees[mask], counts[mask], best_roots[mask] = best, tree, count, roots
    return {"cost_numerator": costs[full], "denominator": len(events),
            "expected_bytes": str(Fraction(costs[full], len(events))),
            "tree": trees[full], "optimal_tree_count": counts[full],
            "optimal_root_partitions": [list(p) for p in best_roots[full]],
            "subsets_solved": len(costs), "root_partitions_considered": considered}


def tree_cost(tree, events, *, header=512, slot=320, installations=0):
    """Direct, integer-numerator evaluation of one nested-list tree."""
    if isinstance(tree, int):
        return 1 << tree, 0
    coverage, subtotal = 0, 0
    for child in tree:
        mask, cost = tree_cost(child, events, header=header, slot=slot,
                               installations=installations)
        if coverage & mask:
            raise ValueError("overlapping leaf identities")
        coverage |= mask
        subtotal += cost
    if len(tree) < 2:
        raise ValueError("unary internal node")
    weight = sum(bool(event & coverage) for event in events) + installations * len(events)
    return coverage, subtotal + (header + slot * len(tree)) * weight


def moments(n, events):
    return {"denominator": len(events),
            "singletons": [sum(bool(e & (1 << i)) for e in events) for i in range(n)],
            "pairs": [[sum(bool(e & (1 << i)) and bool(e & (1 << j)) for e in events)
                       for j in range(n)] for i in range(n)]}


def build_report():
    # Six always-active anchors and the even/odd parity distribution on 0,1,2.
    anchors = sum(1 << i for i in range(3, 9))
    distributions = {"P": [anchors | m for m in (0, 3, 5, 6)],
                     "Q": [anchors | m for m in (1, 2, 4, 7)]}
    summaries = {name: moments(9, events) for name, events in distributions.items()}
    assert summaries["P"] == summaries["Q"]
    results = {}
    for installations in (0, 1):
        case = {name: solve(9, events, installations=installations)
                for name, events in distributions.items()}
        for name, events in distributions.items():
            for source in ("P", "Q"):
                _, numerator = tree_cost(case[source]["tree"], events,
                                         installations=installations)
                case[name]["cost_of_" + source + "_optimal_tree"] = str(Fraction(numerator, 4))
        results[str(installations)] = case
    return {"schema": "hact-pairwise-identifiability-1", "kind": "analytical witness, not deployment data",
            "n": 9, "fanout": 8, "header_bytes": 512, "slot_bytes": 320,
            "distributions_as_uniform_bitmasks": distributions,
            "identical_pairwise_moments": summaries["P"],
            "scope": "all labeled rooted trees with internal arities 2..8; no order constraint",
            "installation_cases": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="refresh deterministic analytical witness")
    args = parser.parse_args()
    expected = json.dumps(build_report(), indent=2, sort_keys=True) + "\n"
    if args.write:
        RESULT.parent.mkdir(parents=True, exist_ok=True)
        RESULT.write_text(expected)
    elif not RESULT.exists() or RESULT.read_text() != expected:
        raise SystemExit("analytical witness differs; inspect before running --write")
    print(json.dumps({"status": "PASS", "reference": str(RESULT.relative_to(ROOT)),
                      "refresh_optima_bytes": {"P": 3856, "Q": 3936}}))


if __name__ == "__main__":
    main()
