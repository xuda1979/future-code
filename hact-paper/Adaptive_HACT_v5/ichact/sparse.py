"""Bounded sparse ordering proposal; never a verifier or deployment certificate.

Only positive co-occurrences are stored. A maximum-spanning forest followed
by deterministic DFS proposes a display order; validation still prices full
completion sets. This is not sparse emulation of dense average linkage.
"""
from __future__ import annotations

from collections import Counter
from fractions import Fraction
from itertools import combinations

from ichact.layout import Layout, permutation
from ichact.practical import balanced_layout


def sparse_order(training, n, *, max_wave_width=8, max_edges=1_000_000):
    if type(n) is not int or n < 1:
        raise ValueError('positive registry size required')
    if any(type(x) is not int or x < 1 for x in (max_wave_width, max_edges)):
        raise ValueError('positive integer width and edge budgets required')
    singles, pairs = [0] * n, Counter()
    episodes = waves = 0
    for episode in training:
        episodes += 1
        for wave in episode:
            values = tuple(wave)
            if any(type(i) is not int or not 0 <= i < n for i in values):
                raise ValueError('invalid canonical completion index')
            ids = sorted(set(values))
            if len(ids) > max_wave_width:
                raise ValueError('wave exceeds the declared sparse width')
            waves += 1
            for i in ids:
                singles[i] += 1
            for edge in combinations(ids, 2):
                if edge not in pairs and len(pairs) >= max_edges:
                    raise MemoryError('positive edge budget exceeded; no truncated proposal')
                pairs[edge] += 1
    if not episodes or not waves:
        raise ValueError('nonempty training observations required')
    # Exact rational tie ordering; no n-by-n array or zero-affinity edges.
    edges = sorted(pairs, key=lambda e: (-Fraction(pairs[e], singles[e[0]] +
                                                   singles[e[1]] - pairs[e]), e))
    parents, sizes = list(range(n)), [1] * n
    forest = [[] for _ in range(n)]

    def find(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i

    selected = 0
    for left, right in edges:
        a, b = find(left), find(right)
        if a == b:
            continue
        if (sizes[a], -a) < (sizes[b], -b):
            a, b = b, a
        parents[b] = a
        sizes[a] += sizes[b]
        forest[left].append(right)
        forest[right].append(left)
        selected += 1
    # Adjacency order is derived from the same exact edge weights, not hash
    # insertion order. Components and unobserved leaves start canonically.
    for i, neighbours in enumerate(forest):
        neighbours.sort(key=lambda j: (-Fraction(pairs[tuple(sorted((i, j)))],
            singles[i] + singles[j] - pairs[tuple(sorted((i, j)))]), j))
    seen, answer = set(), []
    for start in range(n):
        if start in seen:
            continue
        todo = [start]
        while todo:
            i = todo.pop()
            if i in seen:
                continue
            seen.add(i)
            answer.append(i)
            todo.extend(reversed(forest[i]))
    return permutation(answer, n), {
        'method': 'positive_jaccard_maximum_spanning_forest_dfs',
        'n': n, 'positive_edges': len(pairs), 'forest_edges': selected,
        'components': n - selected, 'training_episodes': episodes,
        'training_waves': waves, 'max_wave_width': max_wave_width,
        'max_edges': max_edges, 'dense_affinity_allocated': False,
        'scope': 'ordering proposal; not dense average linkage or a global optimum'}


def touched_cost(layout: Layout, episodes):
    """Full padded costs using dirty ancestor sets, without dense masks.

    A literal all-node scorer is used independently in the follow-up audit.
    The ancestor index takes O(n*height) references, separate from sparse E.
    """
    n = len(layout.registry)
    by_semantic = [[] for _ in range(n)]
    prices = {}

    def visit(node, ancestors):
        if node.leaf:
            by_semantic[layout.order[node.lo]] = ancestors
            return
        key = len(prices)
        prices[key] = layout.model.packet_bytes(len(node.children))
        for child in node.children:
            visit(child, ancestors + [key])
    visit(layout.tree, [])
    result = []
    for episode in episodes:
        total = sum(prices.values())
        for wave in episode:
            dirty = set()
            for i in wave:
                if type(i) is not int or not 0 <= i < n:
                    raise ValueError('invalid canonical completion index')
                dirty.update(by_semantic[i])
            total += sum(prices[k] for k in dirty)
        result.append(total)
    return result


def select_sparse(registry, training, validation, *, max_edges=1_000_000):
    ids = tuple(registry)
    incumbent = balanced_layout(ids)
    order, info = sparse_order(training, len(ids), max_edges=max_edges)
    proposed = balanced_layout(ids, order)
    if not validation:
        raise ValueError('separate nonempty validation required')
    candidates = {'original': incumbent, 'sparse': proposed}
    totals = {name: sum(touched_cost(layout, validation))
              for name, layout in candidates.items()}
    name = min(totals, key=totals.get)  # Incumbent first on ties.
    return candidates[name], {**info, 'selected': name,
        'validation_total_padded_bytes': totals,
        'candidate_ids': {name: item.uid for name, item in candidates.items()},
        'scope': 'validation-selected compact catalogue; no cap64 fit or service claim'}
