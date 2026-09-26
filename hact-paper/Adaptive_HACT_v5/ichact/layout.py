"""Learned *display* order over an immutable semantic registry.

Pairwise seriation is only a proposal mechanism. Trees are fitted/scored using
complete completion-wave sets, not pairwise approximations to those sets.
"""
from __future__ import annotations
from dataclasses import dataclass
import heapq
from typing import Sequence
import numpy as np
from hact.tree import CostModel, Node, validate_tree
from hact.certificates import canonical, digest
from .frontier import fit_frontiers, full_bytes


def permutation(values: Sequence[int], n: int) -> tuple[int, ...]:
    values = tuple(values)
    if len(values) != n or any(type(i) is not int for i in values) or set(values) != set(range(n)):
        raise ValueError('layout must be an exact integer registry permutation')
    return values


def _decode(value: dict) -> Node:
    if not isinstance(value, dict) or set(value) != {'lo', 'hi', 'children'}:
        raise ValueError('invalid tree object')
    if any(type(value[k]) is not int for k in ('lo', 'hi')) or not isinstance(value['children'], list):
        raise ValueError('invalid tree types')
    return Node(value['lo'], value['hi'], tuple(_decode(x) for x in value['children']))


@dataclass(frozen=True)
class Layout:
    registry: tuple[str, ...]
    order: tuple[int, ...]
    tree: Node
    model: CostModel = CostModel()

    def __post_init__(self):
        if not self.registry or len(set(self.registry)) != len(self.registry) or any(not isinstance(g, str) or not g for g in self.registry):
            raise ValueError('nonempty unique semantic IDs required')
        if not isinstance(self.registry, tuple) or not isinstance(self.order, tuple):
            raise ValueError('immutable registry and order tuples required')
        permutation(self.order, len(self.registry))
        validate_tree(self.tree, len(self.registry), self.model)

    @property
    def uid(self) -> str:
        return digest(self.to_dict())

    def to_dict(self) -> dict:
        return {'schema': 'adaptive-hact-layout-1', 'registry': list(self.registry),
                'order': list(self.order), 'tree': self.tree.to_dict(),
                'model': {'header': self.model.header, 'card': self.model.card, 'cap': self.model.cap}}

    @classmethod
    def from_dict(cls, value: dict) -> 'Layout':
        if not isinstance(value, dict) or set(value) != {'schema', 'registry', 'order', 'tree', 'model'} or value['schema'] != 'adaptive-hact-layout-1':
            raise ValueError('invalid layout schema')
        if not isinstance(value['registry'], list) or not isinstance(value['order'], list):
            raise ValueError('layout lists required')
        return cls(tuple(value['registry']), tuple(value['order']), _decode(value['tree']), CostModel(**value['model']))

    def manifest_bytes(self) -> bytes:
        # A control-plane artifact, paged/referenced rather than inserted in a model prompt.
        return canonical(self.to_dict())

    def coverage(self) -> list[tuple[int, int]]:
        return [(sum(1 << self.order[p] for p in range(v.lo, v.hi + 1)),
                 self.model.packet_bytes(len(v.children))) for v in self.tree.walk() if not v.leaf]

    def cost(self, waves: Sequence[Sequence[int]], *, initial: bool = True) -> int:
        cov = self.coverage()
        total = full_bytes(self.tree, self.model) if initial else 0
        for wave in waves:
            mask = 0
            for i in wave:
                if type(i) is not int or not 0 <= i < len(self.registry):
                    raise ValueError('unknown canonical obligation index')
                mask |= 1 << i
            total += sum(price for covered, price in cov if mask & covered)
        return total


def fit_layout(registry: Sequence[str], episodes, order=None, model=CostModel()) -> Layout:
    n = len(registry)
    order = permutation(range(n) if order is None else order, n)
    inverse = {canonical_id: p for p, canonical_id in enumerate(order)}
    converted = []
    for episode in episodes:
        converted.append([[inverse[i] for i in wave] for wave in episode])
    tree, _ = fit_frontiers(converted, n, model)
    return Layout(tuple(registry), order, tree, model)


def jaccard_affinity(episodes, n: int) -> np.ndarray:
    if type(n) is not int or n < 1:
        raise ValueError('positive registry size required')
    waves = [wave for episode in episodes for wave in episode]
    counts = np.zeros(n, dtype=float)
    joint = np.zeros((n, n), dtype=float)
    for wave in waves:
        if any(type(i) is not int or not 0 <= i < n for i in wave):
            raise ValueError('invalid canonical wave')
        indices = sorted(set(wave))
        counts[indices] += 1
        joint[np.ix_(indices, indices)] += 1
    union = counts[:, None] + counts[None, :] - joint
    affinity = np.divide(joint, union, out=np.zeros_like(joint), where=union > 0)
    np.fill_diagonal(affinity, 0)
    return affinity


def _validate_affinity(a):
    a = np.asarray(a, dtype=float)
    if a.ndim != 2 or a.shape[0] != a.shape[1] or not len(a) or not np.isfinite(a).all() or np.any(a < 0) or not np.allclose(a, a.T):
        raise ValueError('finite nonnegative symmetric affinity required')
    return a


def cluster_order(a) -> tuple[int, ...]:
    """Deterministic average-linkage; endpoint orientation maximizes affinity.

    O(n^2 log n) heap operations and O(n^2) space. Not a globally optimal
    permutation. Unobserved leaves have zero, not invented, affinity.
    """
    a = _validate_affinity(a); n = len(a)
    if not np.any(a):
        return tuple(range(n))
    groups = {i: (i,) for i in range(n)}
    sizes = {i: 1 for i in groups}
    sim = {(i, j): float(a[i, j]) for i in range(n) for j in range(i + 1, n)}
    heap = [(-v, i, j) for (i, j), v in sim.items()]
    heapq.heapify(heap); next_id = n
    while len(groups) > 1:
        while True:
            _, left, right = heapq.heappop(heap)
            if left in groups and right in groups:
                break
        x, y = groups[left], groups[right]
        options = []
        for u, v in ((x, y), (y, x)):
            for ru in (u, u[::-1]):
                for rv in (v, v[::-1]):
                    options.append((-float(a[ru[-1], rv[0]]), ru + rv))
        joined = min(options)[1]
        old_left, old_right = sizes[left], sizes[right]
        remaining = [i for i in groups if i not in (left, right)]
        for other in remaining:
            value = (old_left * sim[tuple(sorted((left, other)))] + old_right * sim[tuple(sorted((right, other)))]) / (old_left + old_right)
            key = (other, next_id); sim[key] = value
            heapq.heappush(heap, (-value, *key))
        del groups[left], groups[right]
        groups[next_id] = joined; sizes[next_id] = old_left + old_right
        next_id += 1
    answer = next(iter(groups.values()))
    return min(answer, answer[::-1])


def spectral_order(a) -> tuple[int, ...]:
    """Fiedler seriation per connected component; degenerate spectra fall back.

    Eigenspaces with multiplicity are not given a fictitious canonical vector.
    """
    a = _validate_affinity(a); n = len(a); unseen = set(range(n)); components = []
    while unseen:
        todo = [min(unseen)]; comp = []
        while todo:
            i = todo.pop()
            if i not in unseen:
                continue
            unseen.remove(i); comp.append(i)
            todo.extend(j for j in sorted(unseen) if a[i, j] > 1e-12)
        components.append(sorted(comp))
    answer = []
    for ids in components:
        if len(ids) < 3:
            answer.extend(ids); continue
        sub = a[np.ix_(ids, ids)]
        laplacian = np.diag(sub.sum(axis=1)) - sub
        vals, vecs = np.linalg.eigh(laplacian)
        if abs(vals[2] - vals[1]) < 1e-10 * max(1, abs(vals[-1])):
            local = cluster_order(sub)
        else:
            vector = vecs[:, 1]
            if vector[int(np.argmax(np.abs(vector)))] < 0:
                vector = -vector
            local = tuple(sorted(range(len(ids)), key=lambda j: (float(vector[j]), j)))
        order = tuple(ids[j] for j in local)
        answer.extend(min(order, order[::-1]))
    return tuple(answer)


def fit_catalogue(registry, training, model=CostModel()) -> dict[str, Layout]:
    affinity = jaccard_affinity(training, len(registry))
    proposals = {'original': tuple(range(len(registry))), 'spectral': spectral_order(affinity), 'cluster': cluster_order(affinity)}
    return {name: fit_layout(registry, training, order, model) for name, order in proposals.items()}


def select_validation(catalogue: dict[str, Layout], validation) -> tuple[str, dict[str, float]]:
    if not catalogue or not validation:
        raise ValueError('pre-fitted candidates and separate validation episodes required')
    scores = {name: float(np.mean([layout.cost(ep) for ep in validation])) for name, layout in catalogue.items()}
    # Dictionary insertion order gives an incumbent-favoring deterministic tie break.
    return min(scores, key=scores.get), scores
