"""Exact microtree optimization under a fixed contiguous block backbone.

This is NOT a global approximation guarantee. Macro topology and display order
are held fixed. Training hyperedges, never evaluation waves, fit each microtree.
"""
from __future__ import annotations
from hact.tree import Node,CostModel,compact_balanced
from .layout import Layout,permutation
from .frontier import fit_frontiers


def fit_blocked(registry,episodes,order=None,*,block_size=32,model=CostModel()):
    registry=tuple(registry);n=len(registry)
    if type(block_size) is not int or block_size<2:raise ValueError('block_size >= 2 required')
    if not episodes or not n:raise ValueError('nonempty registry and training required')
    order=permutation(range(n) if order is None else order,n)
    inverse={g:p for p,g in enumerate(order)}
    transformed=[]
    for ep in episodes:
        converted=[]
        for wave in ep:
            if any(type(g) is not int or g not in inverse for g in wave):raise ValueError('invalid canonical check index')
            converted.append([inverse[g] for g in set(wave)])
        transformed.append(converted)
    blocks=[]
    def offset(node,lo):return Node(node.lo+lo,node.hi+lo,tuple(offset(c,lo) for c in node.children))
    for lo in range(0,n,block_size):
        hi=min(n,lo+block_size)
        local=[[[p-lo for p in wave if lo<=p<hi] for wave in ep] for ep in transformed]
        tree,_=fit_frontiers(local,hi-lo,model)
        blocks.append(offset(tree,lo))
    macro=compact_balanced(len(blocks),model.fanout)
    def expand(node):
        if node.leaf:return blocks[node.lo]
        children=tuple(expand(c) for c in node.children)
        return Node(children[0].lo,children[-1].hi,children)
    return Layout(registry,order,expand(macro),model)
