import itertools,json
import numpy as np
import pytest
from ichact.online import CoupledShare,maximal_coupling,offline_oracle,tracking_bound


def test_causal_api_and_pending_enforcement():
    agent=CoupledShare(2,100,[[0,5],[5,0]])
    with pytest.raises(ValueError):agent.observe([1,2])
    assert agent.choose() in (0,1)
    with pytest.raises(ValueError):agent.choose()
    with pytest.raises(ValueError):agent.state()
    agent.observe([1,2]);assert agent.round==1


def test_resume_exact_decisions_and_costs():
    c=CoupledShare(3,100,np.ones((3,3))-np.eye(3),seed=44)
    for _ in range(7):c.choose();c.observe([0,40,90])
    d=CoupledShare.resume(json.loads(json.dumps(c.state())))
    for _ in range(50):
        assert c.choose()==d.choose()
        assert c.observe([90,0,2])==d.observe([90,0,2])
    assert c.state()==d.state()


def test_no_information_no_pointless_switches():
    c=CoupledShare(8,100,np.ones((8,8))-np.eye(8),seed=4)
    for _ in range(1000):c.choose();c.observe([50]*8)
    assert c.switches==0


def test_coupling_preserves_new_distribution():
    old=np.array([.8,.1,.1]);new=np.array([.1,.45,.45]);rng=np.random.default_rng(7)
    hist=np.zeros(3);changes=0
    for _ in range(18000):
        i=int(rng.choice(3,p=old));j=maximal_coupling(old,new,i,rng)
        hist[j]+=1;changes+=int(i!=j)
    assert np.max(np.abs(hist/18000-new))<.018
    assert abs(changes/18000-np.abs(old-new).sum()/2)<.018


def test_maximal_coupling_fewer_switches_than_independent():
    outputs=[]
    for coupled in (True,False):
        c=CoupledShare(3,100,(np.ones((3,3))-np.eye(3))*20,seed=9,coupled=coupled)
        for _ in range(500):c.choose();c.observe([0,1,2])
        outputs.append(c.switches)
    assert outputs[0]<outputs[1]

@pytest.mark.parametrize('bad',[[0,200],[np.nan,0],[-1,0],[1]])
def test_invalid_or_out_of_bound_loss_rejected(bad):
    c=CoupledShare(2,10,[[0,1],[1,0]]);c.choose()
    with pytest.raises(ValueError):c.observe(bad)
    assert c.round==0


def test_offline_oracle_matches_exhaustive():
    costs=np.array([[3,4],[7,1],[4,0],[1,8]])
    matrix=np.array([[0,3],[4,0]])
    expected=min(sum(costs[t,p[t]] for t in range(4))+sum(matrix[p[t-1],p[t]] for t in range(1,4)) for p in itertools.product(range(2),repeat=4))
    value,path=offline_oracle(costs,matrix)
    assert value==expected
    assert len(path)==4


def test_theory_bound_and_zero_share():
    assert tracking_bound(100,3,100,20,.2,.01,3)>0
    assert tracking_bound(100,3,100,20,.2,0,3)==float('inf')
    assert np.isfinite(tracking_bound(100,3,100,20,.2,0,0))
