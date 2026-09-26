import numpy as np
import pytest
from hact.tree import validate_tree
from ichact.blocked import fit_blocked
from ichact.layout import fit_layout

@pytest.mark.parametrize('n',[1,2,5,8,17,33])
def test_single_block_equals_exact(n):
    rng=np.random.default_rng(n);episodes=[[np.flatnonzero(rng.random(n)<.3).tolist()] for _ in range(8)]
    reg=tuple(map(str,range(n)));order=tuple(map(int,rng.permutation(n)))
    exact=fit_layout(reg,episodes,order);blocked=fit_blocked(reg,episodes,order,block_size=max(2,n))
    assert blocked.tree==exact.tree

@pytest.mark.parametrize('n',[7,16,31,65])
def test_restricted_not_below_exact_training(n):
    rng=np.random.default_rng(n);ep=[[np.flatnonzero(rng.random(n)<.25).tolist()] for _ in range(7)]
    reg=tuple(map(str,range(n)));order=tuple(map(int,rng.permutation(n)))
    b=fit_blocked(reg,ep,order,block_size=4);e=fit_layout(reg,ep,order)
    validate_tree(b.tree,n,b.model)
    assert sum(b.cost(x) for x in ep)>=sum(e.cost(x) for x in ep)
    assert {v.lo for v in b.tree.walk() if v.leaf}==set(range(n))

@pytest.mark.parametrize('kwargs',[{'block_size':1},{'block_size':True},{'order':(0,0)}])
def test_bad_input(kwargs):
    with pytest.raises(ValueError):fit_blocked(('a','b'),[[[0]]],**kwargs)

def test_invalid_check_and_empty():
    for e in ([],[[[4]]],[[[True]]]):
        with pytest.raises(ValueError):fit_blocked(('a','b'),e)
