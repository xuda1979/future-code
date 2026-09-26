import json
from dataclasses import replace
import pytest
from hact.tree import CostModel, balanced, episode_cost, Node
from hact.certificates import Gate, Evidence, Kernel, Capsule, digest

def setup(n=16):
    gates=[Gate('g'+str(i),('a'+str(i//4),)) for i in range(n)]
    k=Kernel(gates,{'a'+str(i//4):digest(i//4) for i in range(n)})
    for i in range(n): k.submit_trusted(i,Evidence(k.gate_binding(i),'PASS',digest('trace'+str(i))))
    return k,balanced(n,4)

@pytest.mark.parametrize('n',[1,2,8,16,64,512])
def test_all_pass(n):
    k,t=setup(n)
    root,packets=k.refresh(t)
    assert root.counts==(n,0,0) and k.publish(k.ticket())
    assert all(len(p)<=k.model.cap for p in packets)
    assert sum(map(len,packets))==episode_cost(t,list(range(n)),k.model)[0]

@pytest.mark.parametrize('status',['FAIL','UNKNOWN'])
def test_negative_never_compensated(status):
    k,t=setup()
    k.submit_trusted(9,Evidence(k.gate_binding(9),status,digest('negative')))
    root,_=k.refresh(t)
    assert root.verdict==status and not k.publish(k.ticket())

def test_incremental_serialization_equals_formula():
    k,t=setup(64)
    k.refresh(t)
    for episode in range(10):
        dirty=k.update_artifacts({'a3':digest(episode)})
        for i in dirty: k.submit_trusted(i,Evidence(k.gate_binding(i),'PASS',digest(('trace',i,episode))))
        root,packets=k.refresh(t)
        assert sum(map(len,packets))==episode_cost(t,sorted(dirty),k.model)[0]
        assert k.publish(k.ticket())

def test_stale_evidence_rejected():
    k,t=setup()
    old=k.records[0]
    k.update_artifacts({'a0':digest('new')})
    with pytest.raises(ValueError,match='stale'): k.submit_trusted(0,old)
    root,_=k.refresh(t)
    assert root.counts==(12,0,4) and not k.publish(k.ticket())

def test_commit_race_rejected():
    k,t=setup()
    k.refresh(t)
    ticket=k.ticket()
    k.update_artifacts({'a0':digest('race')})
    assert not k.publish(ticket)
    with pytest.raises(ValueError): k.ticket()

def test_tree_change_keeps_predicate():
    k,t=setup(64)
    k.refresh(t)
    old=k.ticket()
    root,packets=k.refresh(balanced(64,8))
    assert root.counts==(64,0,0) and k.publish(k.ticket())
    assert not k.publish(old) and packets

def test_duplicate_registry():
    with pytest.raises(ValueError): Kernel([Gate('x',('a',)),Gate('x',('a',))],{'a':'v'})

def test_missing_dependency():
    with pytest.raises(ValueError): Kernel([Gate('x',('missing',))],{'a':'v'})

def test_drop_or_duplicate_coverage():
    k,t=setup()
    for bad in (Node(0,15,(Node(0,0),Node(2,15))),Node(0,15,(Node(0,8),Node(8,15)))):
        with pytest.raises(ValueError): k.refresh(bad)

def test_tampered_capsule():
    k,t=setup()
    root,_=k.refresh(t)
    modified=root.as_dict();modified['counts']=[0,16,0]
    assert not k.check_external_capsule(json.dumps(modified).encode(),root)
    assert k.check_external_capsule(root.to_bytes(),root)

def test_no_changes_no_packets():
    k,t=setup();k.refresh(t)
    assert k.update_artifacts({'a0':digest(0)})==set()
    assert k.refresh(t)[1]==[]

def test_max_field_width():
    r=Capsule(0,2**31-2,(2**31-1,0,0),'f'*64,'f'*64,'f'*64)
    assert len(r.to_bytes(319))==319

def test_no_silent_truncation():
    k,t=setup();r,_=k.refresh(t)
    with pytest.raises(ValueError): r.to_bytes(20)

def test_switch_back_to_old_tree_never_revives_stale_pass():
    k,a=setup(16);b=balanced(16,8)
    k.refresh(a);k.refresh(b)
    k.update_artifacts({'a0':digest('changed')})
    k.refresh(a)
    root,_=k.refresh(b)
    assert root.verdict=='UNKNOWN' and not k.publish(k.ticket())

@pytest.mark.parametrize('seed',range(10))
def test_stateful_edits_switches_and_partial_revalidation(seed):
    import numpy as np
    from hact.tree import compact_balanced, optimize, activation_matrix
    rng=np.random.default_rng(seed)
    n=17
    gates=[Gate(f'g{i}',(f'x{i%7}',f'x{(i+1)%7}')) for i in range(n)]
    artifacts={f'x{i}':digest([i,0]) for i in range(7)}
    k=Kernel(gates,artifacts)
    trees=[compact_balanced(n,3),optimize(activation_matrix([[i] for i in range(n)],n))[0]]
    statuses=['UNKNOWN']*n
    for step in range(60):
        asset=f'x{int(rng.integers(7))}'
        invalid=k.update_artifacts({asset:digest([seed,step,asset])})
        for i in invalid:statuses[i]='UNKNOWN'
        for raw_i in rng.choice(n,size=int(rng.integers(1,8)),replace=False):
            i=int(raw_i);status=str(rng.choice(['PASS','FAIL','UNKNOWN']))
            k.submit_trusted(i,Evidence(k.gate_binding(i),status,digest([seed,step,i,status])))
            statuses[i]=status
        root,_=k.refresh(trees[step%2])
        expected=tuple(statuses.count(s) for s in ['PASS','FAIL','UNKNOWN'])
        assert root.counts==expected
        assert k.publish(k.ticket())==(expected==(n,0,0))


def test_microfixture_real_checker():
    from experiments.executable import check, source, definitions
    sources=[source(i,0) for i in range(16)]
    good=check(sources,range(len(definitions())))
    assert len(good)==80 and all(r['status']=='PASS' for r in good)
    sources[4]=source(4,1,True)
    bad=check(sources,range(len(definitions())))
    assert sum(r['status']=='FAIL' for r in bad)==6
