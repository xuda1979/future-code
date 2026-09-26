"""Practical catalogue: retain the incumbent; propose a learned-order fixed tree.

No exact or block DP is called on this path. Pairwise data propose an order;
held-out complete-wave costs choose among complete layouts. This does not make
pairwise affinity a sufficient cost statistic and does not optimize codecs.
"""
from __future__ import annotations
from collections.abc import Sequence
from hact.tree import CostModel, compact_balanced
from .layout import Layout, cluster_order, jaccard_affinity, permutation, select_validation


def balanced_layout(registry: Sequence[str], order=None, *, fanout=8,
                    model=CostModel()) -> Layout:
    if type(fanout) is not int or not 2 <= fanout <= model.fanout:
        raise ValueError('fanout must fit the declared packet cap')
    ids = tuple(registry)
    order = permutation(range(len(ids)) if order is None else order, len(ids))
    return Layout(ids, order, compact_balanced(len(ids), fanout), model)


def practical_catalogue(registry: Sequence[str], training, *, incumbent=None,
                        fanout=8, model=CostModel()) -> dict[str, Layout]:
    """Fit only on training observations. Caller supplies separate validation.

    Incumbent-first insertion gives retention on equal held-out padded cost.
    The supplied incumbent must have exactly the same ordered semantic registry
    and byte contract. No authorization or automatic migration occurs here.
    """
    ids = tuple(registry)
    original = balanced_layout(ids, fanout=fanout, model=model)
    if not training:
        raise ValueError('nonempty training episodes required')
    if incumbent is not None and (not isinstance(incumbent, Layout) or
        incumbent.registry != ids or incumbent.model != model):
        raise ValueError('incumbent acceptance/packet contract mismatch')
    order = cluster_order(jaccard_affinity(training, len(ids)))
    result = {'incumbent': original if incumbent is None else incumbent}
    if result['incumbent'].uid != original.uid:
        result['balanced_original'] = original
    learned = balanced_layout(ids, order, fanout=fanout, model=model)
    if all(learned.uid != value.uid for value in result.values()):
        result['balanced_learned'] = learned
    return result


def select_practical(registry, training, validation, **kwargs):
    """Catalogue-relative padded objective, not a guarantee of deployment gain."""
    catalogue = practical_catalogue(registry, training, **kwargs)
    # Layout.cost checks IDs; validate each observation even when a catalogue
    # was deduplicated to one candidate.
    name, scores = select_validation(catalogue, validation)
    return catalogue[name], {'selected': name, 'scores': scores,
                            'cost_metric': 'padded_certificate_bytes',
                            'candidate_ids': {k: v.uid for k, v in catalogue.items()}}
