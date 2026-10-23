"""Exact global padded-epoch optimizer for an exchangeable completion law.

A uniform random permutation is partitioned into fixed nonempty batch sizes.
Expected coverage hit counts depend only on coverage cardinality. The DP uses
integer numerators under one common denominator: no empirical affinity, float
comparison or leaf-permutation search enters the optimum. The guarantee is
model-specific; dispatch randomization alone does not establish the model.
"""
from fractions import Fraction
from math import comb, lcm
from collections.abc import Sequence

from hact.tree import CostModel, Node
from ichact.layout import Layout


def batch_sizes(n, width):
    if type(n) is not int or n < 1 or type(width) is not int or width < 1:
        raise ValueError('positive integer registry size and width required')
    q, r = divmod(n, width)
    return (width,) * q + ((r,) if r else ())


def cardinality_weights(n, batches, *, initial=True):
    if type(n) is not int or n < 1 or type(initial) is not bool:
        raise ValueError('positive registry size and boolean initial required')
    if not isinstance(batches, Sequence) or isinstance(batches, (str, bytes)) or not batches or any(
            type(w) is not int or w < 1 for w in batches) or sum(batches) != n:
        raise ValueError('batch sizes must be a nonempty positive partition of the registry')
    result = [Fraction(int(initial))]
    for size in range(1, n+1):
        value = Fraction(int(initial))
        for width in set(batches):
            missed = comb(n-size, width) if n-size >= width else 0
            value += batches.count(width) * (1 - Fraction(missed, comb(n, width)))
        result.append(value)
    return tuple(result)


def optimize_exchangeable(registry, batches, *, model=CostModel(), max_n=2048):
    """Global optimum over all arity-feasible trees and leaf permutations.

    O(b*n^2) integer arithmetic operations and O(b*n) states; integer bit
    complexity is additional. A strict epoch includes one cold build. A size
    state's weights always use the original full registry n, not its local size.
    Registry/packet validation is delegated to the resulting immutable Layout.
    Admission bounds the quadratic optimizer separately from all semantic gates.
    """
    ids = tuple(registry)
    if not ids or len(set(ids)) != len(ids) or any(not isinstance(x, str) or not x for x in ids):
        raise ValueError('nonempty unique semantic registry required')
    if type(max_n) is not int or max_n < 1 or len(ids) > max_n:
        raise ValueError('exchangeable optimizer resource admission refused')
    if not isinstance(model, CostModel):
        raise ValueError('validated packet contract required')
    n, b = len(ids), min(len(ids), model.fanout)
    weights = cardinality_weights(n, batches)
    denominator = lcm(*(w.denominator for w in weights))
    integers = [int(w * denominator) for w in weights]
    # None is infeasible; all feasible prices are exact nonnegative integers.
    costs = [None] * (n+1)
    costs[1] = 0
    forests = [[None]*(n+1) for _ in range(b+1)]
    splits = [[None]*(n+1) for _ in range(b+1)]
    arities = [0]*(n+1)
    forests[1][1] = 0
    comparisons = 0
    for size in range(2, n+1):
        for arity in range(2, min(b, size)+1):
            best, chosen = None, None
            for left in range(1, size-arity+2):
                rest = forests[arity-1][size-left]
                if rest is None:
                    continue
                value = costs[left] + rest
                comparisons += 1
                if best is None or value < best:
                    best, chosen = value, left
            forests[arity][size] = best
            splits[arity][size] = chosen
            value = best + integers[size] * model.packet_bytes(arity)
            if costs[size] is None or value < costs[size]:
                costs[size], arities[size] = value, arity
        forests[1][size] = costs[size]

    def tree(size, lo):
        if size == 1:
            return Node(lo, lo)
        arity, remaining, offset = arities[size], size, lo
        children = []
        while arity > 1:
            left = splits[arity][remaining]
            children.append(tree(left, offset))
            offset += left
            remaining -= left
            arity -= 1
        children.append(tree(remaining, offset))
        return Node(lo, lo+size-1, tuple(children))

    layout = Layout(ids, tuple(range(n)), tree(n, 0), model)
    independent_sum = sum(Fraction(model.packet_bytes(len(node.children))) * weights[node.hi-node.lo+1]
                          for node in layout.tree.walk() if not node.leaf)
    optimum = Fraction(costs[n], denominator)
    if independent_sum != optimum:
        raise AssertionError('exchangeable reconstruction objective mismatch')
    return layout, {'method': 'exact_exchangeable_cardinality_dp', 'registry_size': n,
                    'batches': list(batches), 'expected_padded_epoch_bytes': str(optimum),
                    'common_denominator_bits': denominator.bit_length(),
                    'integer_candidate_comparisons': comparisons,
                    'dp_state_bound': 2*(b+1)*(n+1)+2*(n+1),
                    'scope': 'global tree/permutation optimum under the specified exchangeable completion law; not measured workload or service optimality'}
