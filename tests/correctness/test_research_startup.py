"""Regression tests import the production POSIX endpoint; no model/remote spend."""
import concurrent.futures
import fcntl
import importlib.util
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / "scripts" / "research-job-agent.py"
spec = importlib.util.spec_from_file_location("research_startup_endpoint", SOURCE)
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

class StartupRecovery(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "jobs"
        self.config = self.base / "template.json"
        self.counter = self.base / "executions"
        code = f"from pathlib import Path;p=Path({str(self.counter)!r});p.write_text(p.read_text()+'x' if p.exists() else 'x')"
        self.config.write_text(json.dumps({"argv": [sys.executable, "-c", code], "timeoutMs": 2000}))
        self.request = {"schema": 1, "key": "a" * 64, "operation": "ensure", "jobId": None,
                        "input": {"seed": 7}, "inputHash": "bound-input"}
        self.directory = self.root / self.request["key"]

    def ensure(self):
        return agent.endpoint(self.root, self.config, dict(self.request))

    def inspect(self):
        return agent.endpoint(self.root, self.config,
                              {**self.request, "operation": "inspect", "jobId": self.request["key"]})

    def age_launch(self):
        state = agent.read(self.directory / "state.json")
        state.update(created=time.time() - 1000, launchRequestedAt=time.time() - 1000)
        agent.atomic(self.directory / "state.json", state)

    def terminal(self):
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            reply = self.inspect()
            if reply["status"] in ("SUCCEEDED", "FAILED", "CANCELLED"):
                return reply
            time.sleep(0.025)
        self.fail(f"endpoint did not reconcile startup: {reply}")

    def test_inspect_recovers_lost_spawn_without_another_ensure(self):
        with patch.object(agent.subprocess, "Popen") as launch:
            self.assertEqual(self.ensure()["status"], "QUEUED")
            self.assertEqual(launch.call_count, 1)
        self.age_launch()
        result = self.terminal()
        self.assertEqual(result["status"], "SUCCEEDED")
        self.assertEqual(self.counter.read_text(), "x")
        self.assertEqual(self.ensure()["jobId"], result["jobId"])
        self.assertEqual(self.counter.read_text(), "x")

    def test_transient_spawn_error_keeps_a_reconcilable_job(self):
        with patch.object(agent.subprocess, "Popen", side_effect=OSError("temporary capacity failure")):
            self.assertEqual(self.ensure()["status"], "QUEUED")
        self.age_launch()
        self.assertEqual(self.terminal()["status"], "SUCCEEDED")
        self.assertEqual(self.counter.read_text(), "x")

    def test_lost_startup_is_bounded_and_cannot_stall_capacity_forever(self):
        with patch.object(agent.subprocess, "Popen") as launch:
            self.ensure()
            for _ in range(5):
                self.age_launch()
                reply = self.inspect()
                if reply["status"] == "FAILED":
                    break
            self.assertEqual(reply["status"], "FAILED")
            self.assertEqual(launch.call_count, 3)
            self.assertIn("startup", reply["result"]["error"].lower())
            self.assertFalse(self.counter.exists())
            # Even a delayed runner from an earlier launch cannot execute FAILED.
            agent.worker(self.directory)
            self.assertFalse(self.counter.exists())

    def test_inspection_does_not_relaunch_while_worker_owns_queued_record(self):
        with patch.object(agent.subprocess, "Popen"):
            self.ensure()
        self.age_launch()
        before = (self.directory / "state.json").read_bytes()
        with open(self.directory / "worker.lock", "a+b") as guard:
            fcntl.flock(guard, fcntl.LOCK_EX)
            with patch.object(agent.subprocess, "Popen") as launch:
                self.assertEqual(self.inspect()["status"], "QUEUED")
                launch.assert_not_called()
                self.assertEqual((self.directory / "state.json").read_bytes(), before)

    def test_spawned_worker_waits_through_brief_startup_lock_handoff(self):
        with patch.object(agent.subprocess, "Popen"):
            self.ensure()
        with open(self.directory / "worker.lock", "a+b") as guard:
            fcntl.flock(guard, fcntl.LOCK_EX)
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(agent.worker, self.directory)
                time.sleep(0.05)
                self.assertFalse(future.done(), "worker must not abandon QUEUED on brief poller lock contention")
                fcntl.flock(guard, fcntl.LOCK_UN)
                future.result(timeout=3)
        self.assertEqual(self.inspect()["status"], "SUCCEEDED")
        self.assertEqual(self.counter.read_text(), "x")

    def test_running_without_ownership_is_unknown_never_resubmitted(self):
        with patch.object(agent.subprocess, "Popen"):
            self.ensure()
        state = agent.read(self.directory / "state.json")
        agent.atomic(self.directory / "state.json", {**state, "status": "RUNNING"})
        with patch.object(agent.subprocess, "Popen") as launch:
            self.assertEqual(self.inspect()["status"], "UNKNOWN")
            self.assertEqual(self.ensure()["status"], "UNKNOWN")
            launch.assert_not_called()

    def test_concurrent_inspect_and_ensure_still_execute_once(self):
        with patch.object(agent.subprocess, "Popen"):
            self.ensure()
        self.age_launch()
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(self.inspect if i % 2 else self.ensure) for i in range(16)]
            for future in futures:
                self.assertEqual(future.result()["jobId"], self.request["key"])
        self.assertEqual(self.terminal()["status"], "SUCCEEDED")
        self.assertEqual(self.counter.read_text(), "x")

    def test_polling_does_not_spawn_a_worker_per_poll(self):
        with patch.object(agent.subprocess, "Popen") as launch:
            self.ensure()
            for _ in range(20): self.inspect()
            self.assertEqual(launch.call_count, 1)

    def test_corrupt_state_is_not_erased_to_force_progress(self):
        with patch.object(agent.subprocess, "Popen"):
            self.ensure()
        (self.directory / "state.json").write_text("corrupt")
        with patch.object(agent.subprocess, "Popen") as launch:
            with self.assertRaises(ValueError): self.inspect()
            launch.assert_not_called()
        self.assertEqual((self.directory / "state.json").read_text(), "corrupt")

if __name__ == "__main__":
    unittest.main()
