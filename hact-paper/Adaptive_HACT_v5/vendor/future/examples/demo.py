#!/usr/bin/env python3
"""Deterministic LOCAL HTTP fixture; tests orchestration, not model intelligence.

Run after installation: python examples/demo.py --output /tmp/future-control-demo
No hosted model, credentials, original Future Code binary, or paid API is used.
"""
from __future__ import annotations

import argparse
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import time

from future_code.contracts import Config, Endpoint, GateSpec, TaskSpec
from future_code.runtime import Supervisor
from future_code.security import atomic_write, ensure_control
from future_code.store import Store

FINISH = {"action": "finish", "summary": "Submit staged result to the executable acceptance gates", "uncertainties": ["Fixture actions are scripted; no hosted LLM capability was evaluated"]}


def fixture_scripts() -> dict[str, list[dict]]:
    children = [
        {"id": "addition", "title": "Repair addition", "instructions": "Repair calculator.add and validate signed and zero inputs", "priority": 0, "write_scope": ["calculator.py"], "gates": ["addition"]},
        {"id": "statistics", "title": "Implement mean", "instructions": "Add mean for nonempty values; reject empty input", "write_scope": ["statistics_impl.py"], "gates": ["statistics"]},
    ]
    return {
        "project": [{"action": "delegate", "tasks": children}, FINISH],
        "addition": [
            {"action": "read", "path": "calculator.py"},
            {"action": "write", "path": "calculator.py", "content": "def add(a, b):\n    return a * b\n"},
            FINISH,
            {"action": "write", "path": "calculator.py", "content": "def add(a, b):\n    return a + b\n"},
            FINISH,
        ],
        "statistics": [
            {"action": "write", "path": "statistics_impl.py", "content": 'def mean(values):\n    values = tuple(values)\n    if not values:\n        raise ValueError("mean requires at least one value")\n    return sum(values) / len(values)\n'},
            FINISH,
        ],
    }


class FixtureServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, *, transient_first: bool = True):
        super().__init__(("127.0.0.1", 0), FixtureHandler)
        self.lock = threading.Lock()
        self.scripts = fixture_scripts()
        self.indices: dict[str, int] = {}
        self.calls = 0
        self.failures = 0
        self.transient_first = transient_first
        self.peer_ports: set[int] = set()


class FixtureHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        return

    def reply(self, status: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if status == 503:
            self.send_header("Retry-After", "0.03")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.reply(200 if self.path == "/health" else 404, {"fixture": True})

    def do_POST(self):
        size = int(self.headers.get("Content-Length", "0"))
        if not 0 < size <= 1_000_000:
            self.reply(400, {"error": "invalid fixture request size"})
            return
        payload = json.loads(self.rfile.read(size))
        packet = json.loads(payload["messages"][1]["content"])
        task = packet["task"]["id"]
        with self.server.lock:
            self.server.calls += 1
            self.server.peer_ports.add(self.client_address[1])
            if self.server.transient_first and self.server.calls == 1:
                self.server.failures += 1
                self.reply(503, {"error": "intentional demo outage"})
                return
            index = self.server.indices.get(task, 0)
            self.server.indices[task] = index + 1
            actions = self.server.scripts[task]
            action = actions[min(index, len(actions) - 1)]
        # Allow independent network requests to overlap deterministically.
        time.sleep(0.02)
        self.reply(200, {"choices": [{"message": {"content": json.dumps(action)}}]})


def initialize_demo(root: Path, port: int) -> Config:
    if root.exists() and any(root.iterdir()):
        raise ValueError("Demo output must be an empty or nonexistent directory; no project files were changed")
    root.mkdir(parents=True, exist_ok=True)
    (root / "calculator.py").write_text("def add(a, b):\n    return a - b\n")
    acceptance = root / "tests/acceptance"
    acceptance.mkdir(parents=True)
    (acceptance / "test_project.py").write_text('''import unittest
from calculator import add
from statistics_impl import mean

class ProjectAcceptance(unittest.TestCase):
    def test_addition(self):
        for a, b, result in [(2, 3, 5), (-2, 3, 1), (0, 0, 0), (3, -7, -4)]:
            self.assertEqual(add(a, b), result)

    def test_mean(self):
        self.assertEqual(mean([1, 2, 3]), 2)
        self.assertEqual(mean([-1, 1]), 0)
        with self.assertRaises(ValueError):
            mean([])

    def test_composed_behavior(self):
        self.assertEqual(add(mean([2, 4]), mean([4, 6])), 8)
''')
    config = Config(
        endpoint=Endpoint(url=f"http://127.0.0.1:{port}/v1/chat/completions", model="LOCAL_SCRIPTED_FIXTURE_NOT_LLM", health_url=f"http://127.0.0.1:{port}/health", health_interval=0.2),
        max_workers=3, heartbeat_seconds=0.05, lease_seconds=5, stale_seconds=5,
        poll_seconds=0.01, retry_base_seconds=0.03, retry_cap_seconds=0.1, minimum_free_bytes=0,
        max_requests=50, max_reserved_tokens=500_000,
        gates={
            "addition": GateSpec(["$PYTHON", "-c", "from calculator import add; assert add(2,3)==5; assert add(-2,3)==1; assert add(0,0)==0"]),
            "statistics": GateSpec(["$PYTHON", "-c", "from statistics_impl import mean; assert mean([1,2,3])==2; assert mean([-1,1])==0"]),
            "integration": GateSpec(["$PYTHON", "-m", "unittest", "discover", "-s", "tests/acceptance", "-p", "test_*.py"], protected_inputs=["tests/acceptance"]),
        })
    control = ensure_control(root)
    atomic_write(control / "config.json", json.dumps(config.to_dict(), indent=2).encode())
    task = TaskSpec("project", "Repair and compose two independent modules", "Delegate independent components, repair gate failures, then verify their integration", write_scope=["calculator.py", "statistics_impl.py"], gates=["integration"])
    config.validate_task(task)
    with Store(control / "state.db") as db:
        db.add_tasks([task])
    return config


async def exercise(root: Path, config: Config) -> dict:
    supervisor = Supervisor(root, config)
    job = asyncio.create_task(supervisor.run())
    try:
        async with asyncio.timeout(25):
            while not job.done():
                await asyncio.sleep(0.03)
                rows = supervisor.db.tasks()
                if rows and all(row["status"] == "done" for row in rows):
                    supervisor.stop()
                    break
                if any(row["status"] in {"blocked", "failed"} for row in rows):
                    raise RuntimeError("Demo task failed; inspect retained status and evidence")
            result = await job
            if not result["task_states"] or any(s != "done" for s in result["task_states"].values()):
                raise RuntimeError("Demo did not complete its task graph")
            return result
    finally:
        supervisor.stop()
        await asyncio.gather(job, return_exceptions=True)


def run_demo(root: Path) -> dict:
    server = FixtureServer()
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    thread.start()
    try:
        config = initialize_demo(root, server.server_port)
        result = asyncio.run(exercise(root, config))
        with Store(root / ".future-code/state.db", readonly=True) as db:
            gates = db.rows("SELECT task_id,kind,verdict,fingerprint FROM evidence ORDER BY created_at")
        record = {"verdict": "PASS", "scope": "Local scripted HTTP lifecycle, NOT hosted LLM capability",
                  **result, "http_requests": server.calls, "injected_http_503": server.failures,
                  "tcp_connections": len(server.peer_ports), "gate_history": gates,
                  "reports": str(root / ".future-code/reports")}
        atomic_write(root / ".future-code/reports/demo-result.json", json.dumps(record, indent=2).encode())
        return record
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    print(json.dumps(run_demo(arguments.output.resolve()), indent=2))
