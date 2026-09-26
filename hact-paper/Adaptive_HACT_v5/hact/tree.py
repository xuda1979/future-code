"""Optimal ordered certificate trees for set-valued, correlated invalidations.

The dynamic program optimizes communication bytes, not model intelligence, task
makespan, or gate execution cost. All intervals are inclusive and zero-indexed.
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Iterable, Sequence
import math
import numpy as np

@dataclass(frozen=True)
class CostModel:
    header: int = 512
    card: int = 320
    cap: int = 3072

    def __post_init__(self) -> None:
        if any(type(x) is not int or x <= 0 for x in (self.header, self.card, self.cap)):
            raise ValueError('positive integer byte limits required')
        if self.fanout < 2:
            raise ValueError('budget cannot fit two child cards')

    @property
    def fanout(self) -> int:
        return (self.cap - self.header) // self.card

    def packet_bytes(self, arity: int) -> int:
        if not 2 <= arity <= self.fanout:
            raise ValueError('invalid internal-node arity')
        return self.header + self.card * arity

@dataclass(frozen=True)
class Node:
    lo: int
    hi: int
    children: tuple['Node', ...] = ()

    @property
    def leaf(self) -> bool:
        return not self.children

    def walk(self) -> Iterable['Node']:
        yield self
        for child in self.children:
            yield from child.walk()

    def to_dict(self) -> dict:
        return {'lo': self.lo, 'hi': self.hi,
                'children': [c.to_dict() for c in self.children]}


def validate_tree(tree: Node, n: int, model: CostModel) -> None:
    if type(n) is not int or not 1 <= n <= 2**31 - 1:
        raise ValueError('unsupported gate count')
    if (tree.lo, tree.hi) != (0, n - 1):
        raise ValueError('root does not cover registry')
    for node in tree.walk():
        if not 0 <= node.lo <= node.hi < n:
            raise ValueError('invalid interval')
        if node.leaf:
            if node.lo != node.hi:
                raise ValueError('non-singleton leaf')
            continue
        model.packet_bytes(len(node.children))
        end = node.lo
        for child in node.children:
            if child.lo != end:
                raise ValueError('overlap or missing coverage')
            end = child.hi + 1
        if end != node.hi + 1:
            raise ValueError('children do not partition parent')


def activation_matrix(episodes: Sequence[Sequence[int]], n: int) -> np.ndarray:
    """Empirical Pr(S intersects [i,j]); no within-episode independence assumed."""
    if n < 1 or not episodes:
        raise ValueError('nonempty dataset and positive n required')
    active = np.zeros((len(episodes), n), dtype=np.int32)
    for row, episode in enumerate(episodes):
        for index in episode:
            if type(index) is not int or not 0 <= index < n:
                raise ValueError('invalid gate ID')
            active[row, index] = 1
    prefix = np.column_stack((np.zeros(len(episodes), dtype=np.int32), active.cumsum(axis=1)))
    p = np.zeros((n, n), dtype=np.float64)
    for i in range(n):
        p[i, i:] = (prefix[:, i + 1:] > prefix[:, i:i + 1]).mean(axis=0)
    return p


def independence_matrix(p: np.ndarray) -> np.ndarray:
    """Ablation: infer joint activation from marginal Bernoulli probabilities."""
    n = len(p)
    result = np.zeros_like(p)
    diagonal = np.diag(p)
    for i in range(n):
        result[i, i:] = 1.0 - np.cumprod(1.0 - diagonal[i:])
    return result


def optimize(p: np.ndarray, model: CostModel = CostModel()) -> tuple[Node, float]:
    """Exact alphabetic optimum for supplied interval probabilities.

    Float64 arithmetic is used; equality/optimality are to numerical precision.
    F[i,j] is the best tree cost. G[k,i,j] is the best k-tree forest cost.
    Only strict subinterval values enter a length-L forest with k>=2.
    """
    p = np.asarray(p, dtype=np.float64)
    if p.ndim != 2 or p.shape[0] != p.shape[1] or len(p) == 0:
        raise ValueError('nonempty square matrix required')
    n = len(p)
    if not np.isfinite(p).all() or np.any((p < 0) | (p > 1)):
        raise ValueError('probabilities must be finite in [0,1]')
    b = min(model.fanout, n)
    f = np.full((n, n), np.inf)
    forest = np.full((b + 1, n, n), np.inf)
    split = np.full((b + 1, n, n), -1, dtype=np.int32)
    arity = np.zeros((n, n), dtype=np.int16)
    for i in range(n):
        f[i, i] = forest[1, i, i] = 0.0
    for length in range(2, n + 1):
        for i in range(n - length + 1):
            j = i + length - 1
            for k in range(2, min(b, length) + 1):
                stop = j - k + 2
                values = f[i, i:stop] + forest[k - 1, i + 1:stop + 1, j]
                index = int(np.argmin(values))
                forest[k, i, j] = float(values[index])
                split[k, i, j] = i + index
                total = forest[k, i, j] + p[i, j] * model.packet_bytes(k)
                if total < f[i, j]:
                    f[i, j], arity[i, j] = total, k
            forest[1, i, j] = f[i, j]

    def make(i: int, j: int) -> Node:
        if i == j:
            return Node(i, j)
        k = int(arity[i, j])
        children = []
        left = i
        while k > 1:
            t = int(split[k, left, j])
            children.append(make(left, t))
            left, k = t + 1, k - 1
        children.append(make(left, j))
        return Node(i, j, tuple(children))
    tree = make(0, n - 1)
    validate_tree(tree, n, model)
    return tree, float(f[0, n - 1])


def balanced(n: int, fanout: int, lo: int = 0) -> Node:
    if n < 1 or fanout < 2:
        raise ValueError('invalid balanced tree parameters')
    if n == 1:
        return Node(lo, lo)
    k = min(n, fanout)
    q, r = divmod(n, k)
    children = []
    start = lo
    for index in range(k):
        size = q + (index < r)
        children.append(balanced(size, fanout, start))
        start += size
    return Node(lo, lo + n - 1, tuple(children))


def objective(tree: Node, p: np.ndarray, model: CostModel) -> float:
    return sum(p[v.lo, v.hi] * model.packet_bytes(len(v.children))
               for v in tree.walk() if not v.leaf)


def episode_cost(tree: Node, updated: Sequence[int], model: CostModel) -> tuple[int, int]:
    ids = set(updated)
    cost = count = 0
    for node in tree.walk():
        if not node.leaf and any(node.lo <= i <= node.hi for i in ids):
            count += 1
            cost += model.packet_bytes(len(node.children))
    return cost, count


def stats(tree: Node, model: CostModel) -> dict:
    def height(v: Node) -> int:
        return 0 if v.leaf else 1 + max(height(c) for c in v.children)
    nodes = [v for v in tree.walk() if not v.leaf]
    return {'internal_nodes': len(nodes), 'depth': height(tree),
            'max_arity': max((len(v.children) for v in nodes), default=0),
            'max_packet_bytes': max((model.packet_bytes(len(v.children)) for v in nodes), default=0),
            'full_refresh_bytes': sum(model.packet_bytes(len(v.children)) for v in nodes)}


def generalization_radius(n: int, samples: int, delta: float = 0.05) -> float:
    """Uniform interval-frequency bound; may be vacuous and is not clipped."""
    if n < 1 or samples < 1 or not 0 < delta < 1:
        raise ValueError('invalid confidence inputs')
    intervals = n * (n + 1) // 2
    return math.sqrt(math.log(2 * intervals / delta) / (2 * samples))


def compact_balanced(n: int, fanout: int) -> Node:
    """Bottom-up consecutive blocks; singleton groups are promoted, not wrapped."""
    if n < 1 or fanout < 2:
        raise ValueError('invalid compact tree parameters')
    layer = [Node(i, i) for i in range(n)]
    while len(layer) > 1:
        parents = []
        for offset in range(0, len(layer), fanout):
            group = tuple(layer[offset:offset + fanout])
            parents.append(group[0] if len(group) == 1 else Node(group[0].lo, group[-1].hi, group))
        layer = parents
    return layer[0]


def optimize_height(p: np.ndarray, max_depth: int, model: CostModel = CostModel()) -> tuple[Node, float]:
    """Exact extension with a hard number-of-edges root-to-leaf depth ceiling.

    O(H*b*n^3) time and O(H*b*n^2) retained reconstruction state. This is an
    optional latency guard; it does not bound tool or model execution time.
    """
    p = np.asarray(p, dtype=np.float64)
    if p.ndim != 2 or p.shape[0] != p.shape[1] or len(p) == 0 or not np.isfinite(p).all() or np.any((p < 0) | (p > 1)):
        raise ValueError('invalid probability matrix')
    if type(max_depth) is not int or max_depth < 0:
        raise ValueError('nonnegative integer depth required')
    n = len(p); b = min(n, model.fanout)
    if n > model.fanout ** max_depth:
        raise ValueError('infeasible depth/arity budget')
    prev = np.full((n, n), np.inf); np.fill_diagonal(prev, 0.0)
    saved = []
    for depth in range(1, max_depth + 1):
        current = np.full((n, n), np.inf); np.fill_diagonal(current, 0.0)
        forest = np.full((b + 1, n, n), np.inf); forest[1] = prev
        split = np.full((b + 1, n, n), -1, dtype=np.int32)
        arity = np.zeros((n, n), dtype=np.int16)
        for length in range(2, min(n, model.fanout ** depth) + 1):
            for i in range(n - length + 1):
                j = i + length - 1
                for k in range(2, min(b, length) + 1):
                    stop = j - k + 2
                    values = prev[i, i:stop] + forest[k-1, i+1:stop+1, j]
                    index = int(np.argmin(values))
                    forest[k,i,j] = float(values[index]); split[k,i,j] = i+index
                    value = forest[k,i,j] + p[i,j] * model.packet_bytes(k)
                    if value < current[i,j]:
                        current[i,j],arity[i,j] = value,k
        saved.append((split,arity)); prev = current
    def make(i,j,depth):
        if i == j: return Node(i,j)
        split,arity = saved[depth-1]; k=int(arity[i,j]); children=[];left=i
        while k > 1:
            t=int(split[k,left,j]); children.append(make(left,t,depth-1));left=t+1;k-=1
        children.append(make(left,j,depth-1))
        return Node(i,j,tuple(children))
    tree=make(0,n-1,max_depth); validate_tree(tree,n,model)
    return tree,float(prev[0,n-1])
