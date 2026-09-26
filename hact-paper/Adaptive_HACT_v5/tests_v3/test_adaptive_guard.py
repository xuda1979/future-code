from concurrent.futures import ThreadPoolExecutor
import pytest
from hact.tree import compact_balanced
from hact.certificates import digest
from ichact.layout import Layout
from ichact.adaptive_guard import AdaptiveGuard,StableToken
from ichact.online import migration_matrix


def plans(n=16):
    r=tuple(f'g{i}' for i in range(n));tree=compact_balanced(n,8)
    return [Layout(r,tuple(range(n)),tree),Layout(r,tuple(reversed(range(n))),tree)]

def guard():
    p=plans();return AdaptiveGuard(p[0].registry,'snapshot','checker','environment',p[0]),p

def test_old_ticket_revoked_after_reordering_and_back():
    g,p=guard()
    for name in g.registry:g.submit(g.token(name),'PASS',digest(name))
    g.refresh();ticket=g.issue();assert g.authorize(ticket)
    cost=g.migrate(p[1]);assert not g.authorize(ticket)
    assert cost['total_bytes']==migration_matrix(p)[0,1]
    assert cost['verdict']=='PASS'
    next_ticket=g.issue();assert g.authorize(next_ticket)
    g.migrate(p[0]);assert not g.authorize(ticket) and not g.authorize(next_ticket)
    assert g.authorize(g.issue())

def test_partial_evidence_retains_identity_not_position():
    g,p=guard();g.submit(g.token('g0'),'FAIL',digest('fail'));g.refresh()
    g.migrate(p[1]);root,_=g.refresh()
    assert root.counts==(0,1,15)
    assert g.kernel._leaf(g.positions['g0']).verdict=='FAIL'
    assert g.kernel._leaf(g.positions['g15']).verdict=='UNKNOWN'
    with pytest.raises(ValueError):g.issue()

def test_token_issued_before_migration_valid_only_for_same_stable_gate():
    g,p=guard();token=g.token('g0');g.migrate(p[1])
    g.submit(token,'PASS',digest('ok'));assert g.kernel._leaf(g.positions['g0']).verdict=='PASS'
    with pytest.raises(ValueError):g.submit(StableToken(token.epoch,'g15',token.binding),'PASS',digest('ok'))

def test_epoch_aba_and_conflict():
    g,p=guard();old=g.token('g0');g.begin('changed');g.begin('snapshot')
    with pytest.raises(ValueError):g.submit(old,'PASS',digest('ok'))
    token=g.token('g0');g.submit(token,'PASS',digest('one'))
    with pytest.raises(ValueError):g.submit(token,'FAIL',digest('two'))
    g.migrate(p[1]);root,_=g.refresh();assert root.verdict=='FAIL'
    with pytest.raises(ValueError):g.submit(token,'PASS',digest('one'))

def test_same_layout_free_and_foreign_registry_rejected():
    g,p=guard();assert not g.migrate(p[0])['changed']
    foreign=Layout(tuple('x'+v for v in p[0].registry),p[0].order,p[0].tree)
    with pytest.raises(ValueError):g.migrate(foreign)

def test_parallel_submissions_and_migration():
    g,p=guard()
    def put(name):g.submit(g.token(name),'PASS',digest(name))
    with ThreadPoolExecutor(max_workers=8) as ex:
        futures=[ex.submit(put,name) for name in g.registry]
        ex.submit(g.migrate,p[1]).result()
        for f in futures:f.result()
    root,_=g.refresh();assert root.counts==(16,0,0);assert g.authorize(g.issue())
