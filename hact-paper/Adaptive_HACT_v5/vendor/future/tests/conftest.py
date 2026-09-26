from __future__ import annotations
import asyncio
import json
from pathlib import Path
import pytest

from future_code.contracts import Config, GateSpec
from future_code.security import Redactor, ensure_control
from future_code.store import Store


class ScriptBackend:
    def __init__(self, scripts=None, delay=0):
        self.scripts = scripts or {}
        self.indices = {}
        self.requests = []
        self.delay = delay
        self.active = self.peak = self.closed_count = self.probed = 0
        self.redactor = Redactor()

    async def complete(self, messages, task_id, workspace=None):
        self.active += 1
        self.peak = max(self.peak, self.active)
        self.requests.append((task_id, messages, workspace))
        try:
            await asyncio.sleep(self.delay)
            i = self.indices.get(task_id, 0)
            self.indices[task_id] = i + 1
            script = self.scripts.get(task_id, [{"action": "finish", "summary": "Read-only task complete", "uncertainties": ["No executable acceptance gate configured"]}])
            item = script[min(i, len(script) - 1)]
            if isinstance(item, BaseException):
                raise item
            if callable(item):
                item = item(messages, workspace)
            return json.dumps(item) if isinstance(item, (dict, list)) else item
        finally:
            self.active -= 1

    async def probe(self):
        self.probed += 1

    async def close(self):
        self.closed_count += 1


@pytest.fixture
def config():
    return Config(heartbeat_seconds=0.03, lease_seconds=1, stale_seconds=1, poll_seconds=0.005,
                  retry_base_seconds=0.02, retry_cap_seconds=0.1, minimum_free_bytes=0,
                  gates={"ok": GateSpec(["$PYTHON", "-c", "assert 2 + 2 == 4"]),
                         "fail": GateSpec(["$PYTHON", "-c", "raise SystemExit(1)"])})


@pytest.fixture
def db(tmp_path):
    control = ensure_control(tmp_path)
    with Store(control / "state.db") as database:
        yield database


def queue(root: Path, tasks):
    control = ensure_control(root)
    with Store(control / "state.db") as db:
        db.add_tasks(tasks)


def read_tasks(root: Path):
    with Store(root / ".future-code/state.db") as db:
        return db.tasks()
