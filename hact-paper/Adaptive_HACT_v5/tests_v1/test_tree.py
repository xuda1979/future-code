from functools import lru_cache
from itertools import combinations, product
import numpy as np
import pytest
from hact.tree import (Node, CostModel, activation_matrix, independence_matrix,
                       optimize, balanced, validate_tree, objective, episode_cost,
                       generalization_radius)

@lru_cache(None)
def enumerate_trees(lo, hi, b):
    if lo == hi:
        return (Node(lo,hi),)
    result=[]
    for k in range(2,min(b,hi-lo+1)+1):
        for cuts in combinations(range(lo+1,hi+1),k-1):
            points=(lo,)+cuts+(hi+1,)
            sub=[enumerate_trees(points[z],points[z+1]-1,b) for z in range(k)]
            result.extend(Node(lo,hi,ch) for ch in product(*sub))
    return tuple(result)

@pytest.mark.parametrize('n',range(1,8))
@pytest.mark.parametrize('b',[2,3,4])
def test_dp_matches_exhaustive(n,b):
    rng=np.random.default_rng(1100+n+b)
    episodes=[np.flatnonzero(rng.random(n)<.3).tolist() for _ in range(40)]
    p=activation_matrix(episodes,n)
    model=CostModel(cap=512+320*b)
    tree,value=optimize(p,model)
    expected=min(objective(t,p,model) for t in enumerate_trees(0,n-1,b))
    assert abs(value-expected)<1e-8
    assert abs(objective(tree,p,model)-value)<1e-8
    validate_tree(tree,n,model)

@pytest.mark.parametrize('n',[1,2,7,32,64])
def test_expected_cost_equals_episode_average(n):
    rng=np.random.default_rng(290+n)
    episodes=[np.flatnonzero(rng.random(n)<.1).tolist() for _ in range(113)]
    p=activation_matrix(episodes,n)
    tree,_=optimize(p)
    avg=np.mean([episode_cost(tree,e,CostModel())[0] for e in episodes])
    assert abs(avg-objective(tree,p,CostModel()))<1e-8

@pytest.mark.parametrize('n',[1,2,10])
def test_no_update_cost_zero(n):
    p=activation_matrix([[],[]],n)
    tree,value=optimize(p)
    assert value==0 and episode_cost(tree,[],CostModel())==(0,0)

def test_correlations_not_marginals():
    a=activation_matrix([[0,1],[2,3]],4)
    b=activation_matrix([[0,2],[1,3]],4)
    np.testing.assert_array_equal(np.diag(a),np.diag(b))
    assert a[0,1]!=b[0,1]
    np.testing.assert_array_equal(independence_matrix(a),independence_matrix(b))

@pytest.mark.parametrize('bad',[np.array([[float('nan')]]),np.array([[1.1]]),np.array([1]),np.empty((0,0))])
def test_invalid_matrix(bad):
    with pytest.raises(ValueError): optimize(bad)

@pytest.mark.parametrize('tree',[Node(0,2,(Node(0,0),Node(2,2))),Node(0,1,(Node(0,0),Node(0,1))),Node(0,2)])
def test_invalid_coverage(tree):
    with pytest.raises(ValueError): validate_tree(tree,tree.hi+1,CostModel())

def test_tiny_budget_rejected():
    with pytest.raises(ValueError): CostModel(cap=512+319)

def test_unknown_gate_rejected():
    with pytest.raises(ValueError): activation_matrix([[7]],7)

def test_radius():
    assert generalization_radius(64,2000)<generalization_radius(64,200)

@pytest.mark.parametrize('n',range(1,7))
@pytest.mark.parametrize('depth',[1,2,3])
def test_height_dp_matches_enumeration(n,depth):
    from hact.tree import optimize_height, stats
    p=activation_matrix([[i] for i in range(n)],n)
    model=CostModel(cap=512+3*320)
    candidates=[t for t in enumerate_trees(0,n-1,3) if stats(t,model)['depth']<=depth]
    if not candidates:
        with pytest.raises(ValueError): optimize_height(p,depth,model)
    else:
        tree,value=optimize_height(p,depth,model)
        assert stats(tree,model)['depth']<=depth
        assert abs(value-min(objective(t,p,model) for t in candidates))<1e-8


def test_four_gate_marginal_impossibility():
    a=activation_matrix([[0,1],[2,3]],4)
    b=activation_matrix([[0,3],[1,2]],4)
    m=CostModel(cap=1152)
    pairs={(objective(t,a,m)/1152,objective(t,b,m)/1152) for t in enumerate_trees(0,3,2)}
    assert pairs=={(2,3),(3,2.5),(2.5,3)}
