import itertools
import math
import threading
import pytest
from hact.certificates import digest
from hact.tree import CostModel,Node,balanced as fixed_tree
from ichact.frontier import completion_waves,frontier_bytes,fit_frontiers,promotion_test
from ichact.impact import ImpactModel,Intervention
from ichact.guard import EpochGuard


def binary(lo,hi):
    if lo==hi:yield Node(lo,hi);return
    for k in range(lo,hi):
        for a in binary(lo,k):
            for b in binary(k+1,hi):yield Node(lo,hi,(a,b))


def guard(n=4):return EpochGuard([str(i) for i in range(n)],'snapshot','checker','environment')

def fill(g,states):
    for i,status in enumerate(states):g.submit(g.token(i),status,digest([i,status]))

@pytest.mark.parametrize('bad',['UNKNOWN','FAIL'])
def test_incomplete_never_passes(bad):
    g=guard();fill(g,['PASS']*3+[bad]);g.refresh(fixed_tree(4,2))
    with pytest.raises(ValueError):g.issue()

@pytest.mark.parametrize('n',[1,2,8,33,512])
def test_complete_registry_and_packet_cap(n):
    g=guard(n);fill(g,['PASS']*n)
    root,packets=g.refresh(fixed_tree(n,8));t=g.issue();assert g.authorize(t)
    assert root.counts==(n,0,0) and all(len(p)<=3072 for p in packets)

@pytest.mark.parametrize('missing',range(4))
def test_poisoned_graph_cannot_skip(missing):
    g=guard()
    for i in range(4):
        if i!=missing:g.submit(g.token(i),'PASS',digest(i))
    root,_=g.refresh(fixed_tree(4,2));assert root.verdict=='UNKNOWN'
    with pytest.raises(ValueError):g.issue()

@pytest.mark.parametrize('mode',['new','aba','same'])
def test_revision_and_aba_fencing(mode):
    g=guard();old=g.token(0);fill(g,['PASS']*4);g.refresh(fixed_tree(4,2));ticket=g.issue()
    g.begin('new' if mode!='same' else 'snapshot')
    if mode=='aba':g.begin('snapshot')
    assert not g.authorize(ticket)
    with pytest.raises(ValueError):g.submit(old,'PASS',digest(1))


def test_topology_change_revokes_old_ticket():
    g=guard();fill(g,['PASS']*4);g.refresh(fixed_tree(4,2));t=g.issue()
    g.refresh(fixed_tree(4,4));assert not g.authorize(t)
    assert g.authorize(g.issue())

@pytest.mark.parametrize('seed',range(12))
def test_concurrent_epoch_race(seed):
    g=guard(8);token=g.token(seed%8);barrier=threading.Barrier(2);result=[]
    def worker():
        barrier.wait()
        try:g.submit(token,'PASS',digest(seed));result.append('accepted')
        except ValueError:result.append('fenced')
    th=threading.Thread(target=worker);th.start();barrier.wait();g.begin('revision2');th.join()
    g.refresh(fixed_tree(8,8))
    with pytest.raises(ValueError):g.issue()
    assert result[0] in {'accepted','fenced'}

@pytest.mark.parametrize('n',range(2,8))
def test_frontier_dp_against_exhaustive(n):
    model=CostModel(header=512,card=320,cap=1152)
    eps=[completion_waves(list(range(n)),{i},width=1) for i in [0,n-1]]
    tree,cost=fit_frontiers(eps,n,model)
    oracle=min(sum(frontier_bytes(t,x,model) for x in eps)/len(eps) for t in binary(0,n-1))
    assert cost==pytest.approx(oracle)
    assert sum(frontier_bytes(tree,x,model) for x in eps)/len(eps)==pytest.approx(cost)


def test_invalidation_indistinguishability_counterexample():
    model=CostModel(header=512,card=320,cap=1152);c=model.packet_bytes(2)
    a=[completion_waves(range(4),{0},1)];b=[completion_waves(range(4),{3},1)]
    costs=[(frontier_bytes(t,a[0],model)/c,frontier_bytes(t,b[0],model)/c) for t in binary(0,3)]
    assert min(x[0] for x in costs)==4 and min(x[1] for x in costs)==11
    assert min(max(x-4,y-11) for x,y in costs)==1

@pytest.mark.parametrize('width',[1,2,4,8])
def test_actual_kernel_serialization_matches_frontier_formula(width):
    n=12;g=guard(n);order=list(reversed(range(n)));failures={4}
    waves=completion_waves(order,failures,width);tree,_=fit_frontiers([waves],n)
    _,packets=g.refresh(tree);total=sum(map(len,packets))
    for wave in waves:
        for i in wave:g.submit(g.token(i),'FAIL' if i in failures else 'PASS',digest(i))
        root,packets=g.refresh(tree);total+=sum(map(len,packets))
    assert total==frontier_bytes(tree,waves) and root.verdict=='FAIL'

@pytest.mark.parametrize('method',['default','shortest','coverage','global','conditional'])
def test_models_return_permutations(method):
    m=ImpactModel(['a','b','c'],{'a':1,'b':2,'c':3},{'b':['x']},[Intervention('x',frozenset({'b'}),'m0')])
    order=m.order('x',method);assert len(order)==3 and set(order)=={'a','b','c'}
    if method in ['coverage','global','conditional']:assert order[0]=='b'


def test_model_fallback_and_poison():
    m=ImpactModel(['a','b'],{}, {},[]);assert set(m.order('unseen'))=={'a','b'}
    with pytest.raises(ValueError):ImpactModel(['a'],{}, {},[Intervention('x',frozenset({'unknown'}),'x')])
    with pytest.raises(ValueError):ImpactModel(['a'],{'a':float('nan')},{},[])


def test_promotion_gate_uses_uncertainty_and_switch_cost():
    assert not promotion_test([10],[0],cost_bound=10,horizon=100,switch_bytes=0)['promote']
    assert promotion_test([10]*10000,[0]*10000,cost_bound=10,horizon=100,switch_bytes=1)['promote']
    assert not promotion_test([10]*10000,[0]*10000,cost_bound=10,horizon=1,switch_bytes=100)['promote']
    with pytest.raises(ValueError):promotion_test([11],[0],cost_bound=10,horizon=1,switch_bytes=0)


@pytest.mark.parametrize('second',['FAIL','UNKNOWN','PASS'])
def test_conflicting_same_epoch_replay_revokes_pass(second):
    g=guard(2);fill(g,['PASS','PASS']);g.refresh(fixed_tree(2,2));ticket=g.issue()
    with pytest.raises(ValueError,match='conflicting'):
        g.submit(g.token(0),second,digest('different trace'))
    g.refresh(fixed_tree(2,2));assert not g.authorize(ticket)
    with pytest.raises(ValueError):g.issue()
    with pytest.raises(ValueError):g.submit(g.token(0),'PASS',digest('yet another trace'))
    g.begin('fresh');fill(g,['PASS','PASS']);g.refresh(fixed_tree(2,2));assert g.authorize(g.issue())

def test_exact_delivery_retry_is_idempotent():
    g=guard(2);fill(g,['PASS','PASS']);g.refresh(fixed_tree(2,2));ticket=g.issue()
    g.submit(g.token(0),'PASS',digest([0,'PASS']))
    assert g.authorize(ticket)
