import pytest
import numpy as np
from hact.tree import CostModel, validate_tree
from ichact.practical import balanced_layout, practical_catalogue, select_practical
from ichact.layout import Layout

@pytest.mark.parametrize('n', [1,2,8,9,65,512,1024])
def test_balanced_covers_exactly(n):
    ids=tuple(f'g{i}' for i in range(n)); order=tuple(reversed(range(n)))
    layout=balanced_layout(ids,order)
    validate_tree(layout.tree,n,layout.model)
    assert layout.order==order
    assert [v.lo for v in layout.tree.walk() if v.leaf]==list(range(n))
    assert max((len(v.children) for v in layout.tree.walk()),default=0)<=8


def test_practical_never_calls_dp(monkeypatch):
    import ichact.layout
    def forbidden(*a,**k): raise AssertionError('DP is forbidden on the default path')
    monkeypatch.setattr(ichact.layout,'fit_frontiers',forbidden)
    monkeypatch.setattr(ichact.layout,'fit_layout',forbidden)
    reg=tuple(f'g{i}' for i in range(16))
    ep=[[[0,2,4,6,8,10,12,14]],[[1,3,5,7,9,11,13,15]]]*3
    cat=practical_catalogue(reg,ep)
    assert list(cat)[0]=='incumbent' and len(cat)==2
    layout,meta=select_practical(reg,ep,ep)
    assert meta['selected']=='balanced_learned'
    assert sum(layout.cost(x) for x in ep)<sum(cat['incumbent'].cost(x) for x in ep)


def test_ties_retain_actual_incumbent():
    reg=tuple(f'g{i}' for i in range(16));inc=balanced_layout(reg,tuple(reversed(range(16))))
    ep=[[list(range(16))]]*2
    layout,meta=select_practical(reg,ep,ep,incumbent=inc)
    assert layout.uid==inc.uid and meta['selected']=='incumbent'

@pytest.mark.parametrize('bad',[0,1,9,True,2.5])
def test_invalid_fanout(bad):
    with pytest.raises(ValueError):balanced_layout(('a','b'),fanout=bad)

@pytest.mark.parametrize('ep',[[],[[[2]]],[[[True]]]])
def test_invalid_training(ep):
    with pytest.raises(ValueError):practical_catalogue(('a','b'),ep)


def test_bad_incumbent_and_validation():
    with pytest.raises(ValueError):practical_catalogue(('a','b'),[[[0]]],incumbent=balanced_layout(('x','b')))
    with pytest.raises(ValueError):select_practical(('a','b'),[[[0]]],[])
    with pytest.raises(ValueError):select_practical(('a','b'),[[[0]]],[[[3]]])


def test_canonical_evidence_semantics_unchanged():
    reg=('a','b','c','d');a=balanced_layout(reg);b=balanced_layout(reg,(1,3,0,2))
    assert Layout.from_dict(b.to_dict())==b
    assert a.registry==b.registry and sorted(a.order)==sorted(b.order)
