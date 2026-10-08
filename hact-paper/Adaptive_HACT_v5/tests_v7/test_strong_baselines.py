"""Small deterministic regression gates for the new comparison protocol."""
import copy
import pytest
from experiments_v7.strong_baselines import (
    _flat_serialization, _frequency_layout, _seed, _validate_split,
    synthetic_strong_baselines,
)
from ichact.practical import balanced_layout


def fixture():
    reg = tuple(f"ob-{x}" for x in range(16))
    original = balanced_layout(reg)
    learned = balanced_layout(reg, tuple(reversed(range(16))))
    return {"n": 16, "kind": "cluster", "seed": 7,
        "train": [[[0, 1, 2]], [[13, 14, 15]]],
        "validation": [[[0, 1, 2]]],
        "heldout": [[[0, 1, 2]], [[13, 14, 15]]],
        "selected": "incumbent",
        "layouts": {"incumbent": original.to_dict(), "learned": learned.to_dict()},
        "heldout_totals": {"incumbent": sum(original.cost(x) for x in [[[0,1,2]],[[13,14,15]]]),
                          "learned": sum(learned.cost(x) for x in [[[0,1,2]],[[13,14,15]]])}}


def test_repeatable_and_holdout_not_used_to_fit():
    a = fixture()
    result = synthetic_strong_baselines([a], random_layouts=3)
    assert result == synthetic_strong_baselines([a], random_layouts=3)
    b = copy.deepcopy(a)
    b["train"] = [[[7, 8]]]
    # The train-fitted frequency baseline reacts to changes in training data.
    assert _frequency_layout(a).order != _frequency_layout(b).order
    assert result[0]["cost_bytes"]["selected"] == a["heldout_totals"]["incumbent"]


def test_tampered_archived_metric_rejected():
    a = fixture()
    a["heldout_totals"]["incumbent"] -= 1
    with pytest.raises(ValueError, match="frozen score mismatch"):
        synthetic_strong_baselines([a], random_layouts=2)


def test_invalid_wave_refused():
    a = fixture()
    a["train"] = [[[99]]]
    with pytest.raises(ValueError, match="invalid ID"):
        _validate_split(a)


def test_flat_requires_all_obligations():
    evidence = {"registry": ["a", "b"], "executed": ["a"], "records": {
        "a": {"status": "PASS"}}}
    report = {"snapshot": "s", "checker": "c", "environment": "e", "registry_hash": "r",
              "counts": [2,0,0], "verdict": "PASS", "locally_authorized": True}
    with pytest.raises(ValueError, match="incomplete"):
        _flat_serialization(evidence, report)


def test_seed_is_stable_and_separated():
    assert _seed(16, "cluster", 7, 3) == _seed(16, "cluster", 7, 3)
    assert _seed(16, "cluster", 7, 3) != _seed(16, "cluster", 7, 4)
