import copy
import numpy as np
import pytest
from ichact.window import PricedWindow


def test_matches_frozen_window_and_resume():
    costs=np.random.default_rng(2).integers(0,100,(193,4)).astype(float)
    m=np.ones((4,4))*500;np.fill_diagonal(m,0)
    p=PricedWindow(m,initial=1);active=1;service=sw=0
    for t,v in enumerate(costs):
        if t:
            means=costs[max(0,t-64):t].mean(axis=0);candidate=int(means.argmin())
            if 64*(means[active]-means[candidate])>m[active,candidate]:sw+=m[active,candidate];active=candidate
        assert p.choose()==active
        p.observe(v);service+=v[active]
        if t%7==0:p=PricedWindow.resume(p.state())
    assert p.service==service and p.switch_cost==sw

@pytest.mark.parametrize('matrix',[[[0,-1],[1,0]],[[1,2],[2,0]],[[0,float('nan')],[2,0]],[],[[0,1,2],[3,4,5]]])
def test_bad_matrix(matrix):
    with pytest.raises(ValueError):PricedWindow(matrix)

@pytest.mark.parametrize('costs',[[1],[-1,2],[1,float('inf')],[float('nan'),2]])
def test_invalid_measurements_preserve_pending(costs):
    p=PricedWindow([[0,2],[2,0]]);p.choose()
    with pytest.raises(ValueError):p.observe(costs)
    p.observe([1,2]);assert p.round==1

def test_protocol_and_tie():
    p=PricedWindow([[0,0],[0,0]],initial=1)
    with pytest.raises(ValueError):p.observe([1,2])
    assert p.choose()==1
    with pytest.raises(ValueError):p.choose()
    with pytest.raises(ValueError):p.state()
    p.observe([1,1]);assert p.choose()==1
    p.observe([1,1]);assert p.switches==0

@pytest.mark.parametrize('field,value',[('round',-1),('switches',-2),('history',[]),('service',float('nan')),('active',4),('window',0),('schema','wrong')])
def test_bad_checkpoint(field,value):
    p=PricedWindow([[0,1],[1,0]]);p.choose();p.observe([2,3]);s=p.state();s[field]=value
    with pytest.raises((ValueError,TypeError)):PricedWindow.resume(s)
