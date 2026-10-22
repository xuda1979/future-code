"""Exact references for a packet-price-independent pairwise separation.

This module is an analytical witness, not software-workload evidence. It does
not import the HACT compiler, objective, or v10 subset solver. The independent
reference uses restricted-growth set partitions and exact integer numerators.
The theorem holds for every integer b >= 3; enumeration is deliberately capped
at b <= 8 (nine leaves). Sibling order has no effect on this objective.
"""
from __future__ import annotations

import argparse
from fractions import Fraction
from functools import lru_cache
import json
from pathlib import Path


def _parameters(fanout: int, header: int, slot: int, construction=0):
    if type(fanout) is not int or fanout < 3:
        raise ValueError("integer fanout >= 3 required")
    if type(header) is not int or header < 0:
        raise ValueError("nonnegative integer header required")
    if type(slot) is not int or slot <= 0:
        raise ValueError("positive integer slot required")
    if isinstance(construction, bool):
        raise ValueError("nonnegative rational construction multiplier required")
    multiplier = Fraction(construction)
    if multiplier < 0:
        raise ValueError("nonnegative rational construction multiplier required")
    return fanout, header, slot, multiplier


def distributions(fanout: int):
    """Three parity checks plus b-2 anchors present in every refresh event."""
    if type(fanout) is not int or fanout < 3:
        raise ValueError("integer fanout >= 3 required")
    anchors = frozenset(range(3, fanout + 1))
    return {
        "P": tuple(anchors | frozenset(i for i in range(3) if m & (1 << i))
                   for m in (0, 3, 5, 6)),
        "Q": tuple(anchors | frozenset(i for i in range(3) if m & (1 << i))
                   for m in (1, 2, 4, 7)),
    }


def moment_counts(events, n):
    """Exact singleton/pair counts; no statistic above order two is used."""
    return tuple(tuple(sum(i in event and j in event for event in events)
                       for j in range(n)) for i in range(n))


def formulas(fanout=8, header=512, slot=320, construction=0):
    """Closed forms proved in docs/V11_INDEPENDENT_THEORY_REVIEW.md."""
    b, h, s, multiplier = _parameters(fanout, header, slot, construction)
    w2 = 2 * h + s * (b + 2)
    common = (1 + multiplier) * w2
    regret_p_pair = Fraction(s, 4)
    regret_q_triple = Fraction(h + 2 * s, 4)
    return {
        "fanout": b, "leaves": b + 1, "header": h, "slot": s,
        "construction_multiplier": str(multiplier),
        "two_internal_construction_bytes": w2,
        "P_optimum": str(common - Fraction(h + 3 * s, 4)),
        "Q_optimum": str(common - Fraction(h + 2 * s, 4)),
        "P_optimal_tree_count_unordered": 1,
        "Q_optimal_tree_count_unordered": 3,
        "deterministic_minimax_regret": str(regret_p_pair),
        "randomized_minimax_triple_probability": str(Fraction(s, h + 3 * s)),
        "randomized_minimax_regret": str(
            regret_p_pair * regret_q_triple / (regret_p_pair + regret_q_triple)),
    }


@lru_cache(maxsize=None)
def _set_partitions(labels):
    """Restricted-growth-string construction, independently of bitmask DP."""
    if not labels:
        return ((),)
    groups = [[labels[0]]]
    output = []

    def extend(position):
        if position == len(labels):
            output.append(tuple(tuple(group) for group in groups))
            return
        value = labels[position]
        for group in groups:
            group.append(value)
            extend(position + 1)
            group.pop()
        groups.append([value])
        extend(position + 1)
        groups.pop()

    extend(1)
    return tuple(output)


def exact_reference(events, *, n, fanout, header, slot, construction=0):
    """All labeled tree shapes/permutations, with exact rational objective.

    Entries in `events` are equiprobable sets. The objective is lambda times
    full construction plus expected refresh bytes. The enumerator's n <= 9
    cap limits cost only; it is not an assumption of the general theorem.
    """
    _, h, s, multiplier = _parameters(fanout, header, slot, construction)
    if type(n) is not int or not 1 <= n <= 9 or not events:
        raise ValueError("nonempty event observations and 1 <= n <= 9 required")
    universe = frozenset(range(n))
    events = tuple(frozenset(event) for event in events)
    if any(not event <= universe or any(type(i) is not int for i in event)
           for event in events):
        raise ValueError("unknown semantic leaf")
    count_events = len(events)
    denominator = count_events * multiplier.denominator
    considered = 0

    @lru_cache(maxsize=None)
    def subtree(labels):
        nonlocal considered
        if len(labels) == 1:
            return 0, 1, labels[0], ()
        coverage = frozenset(labels)
        hits = sum(bool(coverage & event) for event in events)
        weight = (count_events * multiplier.numerator
                  + hits * multiplier.denominator)
        best, ways, witness, roots = None, 0, None, []
        for groups in _set_partitions(labels):
            if not 2 <= len(groups) <= fanout:
                continue
            considered += 1
            children = tuple(subtree(group) for group in groups)
            value = (h + s * len(groups)) * weight + sum(c[0] for c in children)
            child_ways = 1
            for child in children:
                child_ways *= child[1]
            if best is None or value < best:
                best, ways = value, child_ways
                witness, roots = tuple(c[2] for c in children), [groups]
            elif value == best:
                ways += child_ways
                roots.append(groups)
        if best is None:
            raise ValueError("no feasible tree")
        return best, ways, witness, tuple(roots)

    numerator, ways, tree, roots = subtree(tuple(range(n)))
    return {"objective": str(Fraction(numerator, denominator)),
            "optimal_tree_count_unordered": ways, "tree": tree,
            "optimal_root_partitions": roots,
            "partitions_across_subproblems": considered,
            "subproblems": subtree.cache_info().currsize}


def check_case(fanout, header, slot, construction=0):
    expected = formulas(fanout, header, slot, construction)
    cases = distributions(fanout)
    n = fanout + 1
    if moment_counts(cases["P"], n) != moment_counts(cases["Q"], n):
        raise AssertionError("pairwise summaries differ")
    references = {
        label: exact_reference(events, n=n, fanout=fanout, header=header,
                               slot=slot, construction=construction)
        for label, events in cases.items()
    }
    for label, record in references.items():
        if record["objective"] != expected[label + "_optimum"]:
            raise AssertionError((label, expected, record))
        if record["optimal_tree_count_unordered"] != expected[label + "_optimal_tree_count_unordered"]:
            raise AssertionError((label, "wrong optimal-tree count", record))
    return {"formula": expected, "reference": references, "status": "PASS"}


def build_report(*, full=False):
    # Prices cover a zero header, equal prices, the deployed prices, and a
    # header-dominated regime; construction includes a genuinely fractional
    # coefficient. The large b=8 case independently reconstructs v10.
    grid = [
        (b, h, s, multiplier)
        for b in (3, 4, 5)
        for h, s in ((0, 1), (1, 1), (512, 320), (10000, 1))
        for multiplier in (0, Fraction(1, 2), 2)
    ]
    if full:
        grid.extend((8, 512, 320, multiplier) for multiplier in (0, Fraction(1, 2), 2))
    checked = [check_case(*case) for case in grid]
    return {
        "schema": "hact-generalized-pairwise-separation-1",
        "kind": "constructed analytical witness; no new software or agent trials",
        "theorem_assumptions": "integer b>=3; H>=0; S>0; lambda>=0; arities 2..b",
        "enumerator_scope": "at most nine labeled leaves; all tree shapes and permutations",
        "checked_cases": len(checked), "cases": checked, "status": "PASS",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--full", action="store_true", help="also solve the nine-leaf default-price cases")
    parser.add_argument("--output", type=Path, help="write a new analytical report; existing files are refused")
    args = parser.parse_args()
    report = build_report(full=args.full)
    encoded = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("x") as stream:
            stream.write(encoded)
        print(json.dumps({"status": "PASS", "checked_cases": report["checked_cases"],
                          "output": str(args.output)}))
    else:
        print(encoded, end="")


if __name__ == "__main__":
    main()
