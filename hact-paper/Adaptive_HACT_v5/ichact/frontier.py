"""Compile verification completion-frontiers rather than invalidation sets.
Every new strict epoch charges its complete initial certificate construction.
"""
from __future__ import annotations
from typing import Sequence
import math
import numpy as np
from hact.tree import CostModel,Node,optimize,activation_matrix,validate_tree

def completion_waves(order:Sequence[int], failures:set[int], width:int=8):
    if type(width) is not int or width<1:raise ValueError('positive wave width required')
    if len(set(order))!=len(order):raise ValueError('duplicate scheduled obligation')
    done=[]
    for g in order:
        done.append(g)
        if g in failures:break
    return [done[i:i+width] for i in range(0,len(done),width)]

def full_bytes(tree:Node,model:CostModel=CostModel()):
    return sum(model.packet_bytes(len(x.children)) for x in tree.walk() if not x.leaf)

def frontier_bytes(tree:Node,waves,model:CostModel=CostModel(),include_initial=True):
    total=full_bytes(tree,model) if include_initial else 0
    for wave in waves:
        for node in tree.walk():
            if not node.leaf and any(node.lo<=g<=node.hi for g in wave):
                total+=model.packet_bytes(len(node.children))
    return total

def fit_frontiers(episodes:Sequence[Sequence[Sequence[int]]],n:int,model:CostModel=CostModel()):
    if not episodes:raise ValueError('training episodes required')
    waves=[list(w) for ep in episodes for w in ep]
    # r(i,j) is expected number of interval activations per epoch, plus the
    # one complete initial construction. It need not be a probability.
    weights=np.triu(np.ones((n,n)))
    if waves:weights+=activation_matrix(waves,n)*(len(waves)/len(episodes))
    scale=float(weights.max())
    tree,value=optimize(weights/scale,model)
    validate_tree(tree,n,model)
    return tree,value*scale

def promotion_test(incumbent_costs,candidate_costs,*,cost_bound:float,horizon:int,
                   switch_bytes:float,candidates:int=1,delta:float=0.05):
    """Holdout-only sufficient condition; NOT a drift-robust guarantee.

    Both per-episode costs lie in [0,cost_bound]. Differences have range 2B.
    Candidate plans must be fixed before seeing these validation observations.
    """
    a=np.asarray(incumbent_costs,dtype=float);b=np.asarray(candidate_costs,dtype=float)
    if a.ndim!=1 or a.shape!=b.shape or not len(a):raise ValueError('paired holdout required')
    if not math.isfinite(cost_bound) or cost_bound<=0 or horizon<1 or candidates<1 or not 0<delta<1:raise ValueError('invalid gate parameters')
    if not math.isfinite(switch_bytes) or switch_bytes<0:raise ValueError('invalid switch price')
    if not np.isfinite(a).all() or not np.isfinite(b).all() or np.any(a<0) or np.any(b<0) or np.any(a>cost_bound) or np.any(b>cost_bound):raise ValueError('cost outside declared bound')
    margin=cost_bound*math.sqrt(2*math.log(candidates/delta)/len(a))
    lower=float((a-b).mean())-margin
    return {'promote':horizon*lower>switch_bytes,'mean_saving':float((a-b).mean()),
            'lower_saving':lower,'margin':margin,'horizon':horizon,'switch_bytes':switch_bytes}
