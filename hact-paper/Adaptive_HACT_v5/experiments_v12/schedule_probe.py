"""Explicit, seeded dispatch intervention; no selection or assertion edits."""
from __future__ import annotations

import os
import random

import pytest


def schedule_ids(ids, policy, seed):
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate semantic identity")
    rng = random.Random(seed)
    if policy == "items":
        result = list(ids)
        rng.shuffle(result)
    elif policy == "files":
        groups = {}
        for cid in ids:
            groups.setdefault(cid.split("::")[0], []).append(cid)
        keys = list(groups)
        rng.shuffle(keys)
        result = [cid for key in keys for cid in groups[key]]
    else:
        raise ValueError("unknown scheduling policy")
    assert sorted(result) == sorted(ids)
    return result


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_collection_modifyitems(session, config, items):
    yield
    from experiments_v11 import public_probe as recorder
    original = [item.nodeid for item in items]
    policy = os.environ["HACT_V12_SCHEDULE_POLICY"]
    seed = int(os.environ["HACT_V12_SCHEDULE_SEED"])
    scheduled = schedule_ids(original, policy, seed)
    by_id = {item.nodeid: item for item in items}
    items[:] = [by_id[cid] for cid in scheduled]
    recorder.STATE.update(
        registry=sorted(original), scheduled=scheduled,
        schedule_intervention={"policy": policy, "seed": seed,
                               "original_collection": original})
    recorder._save()
