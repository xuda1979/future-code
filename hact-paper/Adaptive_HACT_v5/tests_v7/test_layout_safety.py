"""Adversarial semantic/layout separation tests on the real v5 guard."""
from itertools import product
import pytest
from hact.certificates import digest
from ichact.adaptive_guard import AdaptiveGuard
from ichact.practical import balanced_layout


def _guard(order=(0, 1, 2, 3)):
    ids = ("a", "b", "c", "d")
    return AdaptiveGuard(ids, "snapshot-v7", "checker-v7", "environment-v7",
                         balanced_layout(ids, tuple(order)))


@pytest.mark.parametrize("states", list(product(("PASS", "FAIL", "UNKNOWN"), repeat=4)))
def test_canonical_verdict_invariant_across_layout_permutations(states):
    layouts = [(0, 1, 2, 3), (3, 2, 1, 0), (1, 3, 0, 2)]
    results = []
    for order in layouts:
        g = _guard(order)
        for key, status in zip(("a", "b", "c", "d"), states):
            if status != "UNKNOWN":
                g.submit(g.token(key), status, digest((key, status)))
        root, _ = g.refresh()
        passed = all(status == "PASS" for status in states)
        if passed:
            issued = g.issue()
            assert g.authorize(issued)
        else:
            with pytest.raises(ValueError):
                g.issue()
        results.append((root.verdict, root.counts))
    assert len(set(results)) == 1


def test_migration_revokes_stale_ticket_and_retains_canonical_state():
    g = _guard()
    for key in ("a", "b", "c", "d"):
        g.submit(g.token(key), "PASS", digest((key, "PASS")))
    g.refresh()
    old = g.issue()
    assert g.authorize(old)
    migrated = g.migrate(balanced_layout(g.registry, (1, 3, 0, 2)))
    assert migrated["changed"] and migrated["generation"] == 1
    assert not g.authorize(old)
    new = g.issue()
    assert g.authorize(new)
    assert new.generation == old.generation + 1
    assert new.epoch == old.epoch


def test_conflicting_same_epoch_evidence_revokes_ticket_across_migration():
    g = _guard()
    for key in ("a", "b", "c", "d"):
        g.submit(g.token(key), "PASS", digest((key, "PASS")))
    g.refresh()
    ticket = g.issue()
    with pytest.raises(ValueError, match="conflicting"):
        g.submit(g.token("a"), "FAIL", digest(("a", "FAIL")))
    assert not g.authorize(ticket)
    g.migrate(balanced_layout(g.registry, (1, 3, 0, 2)))
    with pytest.raises(ValueError, match="conflicted"):
        g.issue()
