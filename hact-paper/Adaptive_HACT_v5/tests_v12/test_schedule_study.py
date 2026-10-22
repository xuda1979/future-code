import pytest

from experiments_v12.schedule_probe import schedule_ids


@pytest.mark.parametrize("policy", ["files", "items"])
def test_schedule_is_complete_deterministic_and_changes_order(policy):
    ids = [f"test_{i}.py::test_{j}" for i in range(10) for j in range(3)]
    changed = schedule_ids(ids, policy, 2026102101)
    assert sorted(changed) == sorted(ids)
    assert changed != ids
    assert changed == schedule_ids(ids, policy, 2026102101)
    assert changed != schedule_ids(ids, policy, 2026102102)
    if policy == "files":
        for i in range(10):
            group = [x for x in changed if x.startswith(f"test_{i}.py::")]
            assert group == [f"test_{i}.py::test_{j}" for j in range(3)]
            start = changed.index(group[0])
            assert changed[start:start + 3] == group


def test_duplicate_or_unknown_policy_rejected():
    with pytest.raises(ValueError, match="duplicate"):
        schedule_ids(["a", "a"], "files", 1)
    with pytest.raises(ValueError, match="unknown"):
        schedule_ids(["a"], "unknown", 1)
