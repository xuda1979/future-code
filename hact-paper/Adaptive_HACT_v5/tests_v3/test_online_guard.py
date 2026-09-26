"""End-to-end controller choice to stable evidence migration; no external LLM."""
import numpy as np
from hact.tree import compact_balanced
from hact.certificates import digest
from ichact.layout import Layout
from ichact.online import CoupledShare,migration_matrix
from ichact.adaptive_guard import AdaptiveGuard


def test_controller_migration_and_publication_contract():
    registry=tuple('abcdefgh')
    layouts=[Layout(registry,tuple(range(8)),compact_balanced(8,2)),
             Layout(registry,(0,2,4,6,1,3,5,7),compact_balanced(8,4))]
    prices=migration_matrix(layouts)
    controller=CoupledShare(2,10000,prices,eta=.7,share=.1,seed=91)
    guard=AdaptiveGuard(registry,'candidate','checker','environment',layouts[0])
    previous_ticket=None;changes=0
    for epoch in range(60):
        selected=controller.choose()
        migrated=guard.migrate(layouts[selected]);changes+=migrated['changed']
        if migrated['changed'] and previous_ticket is not None:assert not guard.authorize(previous_ticket)
        guard.begin('candidate-'+str(epoch));assert previous_ticket is None or not guard.authorize(previous_ticket)
        guard.refresh()
        for g in registry:guard.submit(guard.token(g),'PASS',digest([epoch,g]))
        root,packets=guard.refresh();assert root.counts==(8,0,0)
        previous_ticket=guard.issue();assert guard.authorize(previous_ticket)
        assert all(len(p)<=3072 for p in packets)
        # Exogenous byte-cost sequence flips after 30 epochs; no peeking at it.
        controller.observe([1000,9000] if epoch<30 else [9000,1000])
    assert changes>0
