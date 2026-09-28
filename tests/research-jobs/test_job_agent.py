import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

AGENT = Path(__file__).resolve().parents[2] / "scripts/research-job-agent.py"


class RemoteJobTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.root = self.base / "jobs"
        self.config = self.base / "config.json"
        self.counter = self.base / "executions"
        code = ("import os,time,json;from pathlib import Path;"
                f"p=Path({str(self.counter)!r});p.write_text(p.read_text()+'x' if p.exists() else 'x');"
                "Path(os.environ['FUTURE_JOB_PROGRESS_PATH']).write_text(json.dumps({'sequence':1}));"
                "time.sleep(0.12);print('verified runner fixture')")
        self.config.write_text(json.dumps({"argv": [sys.executable, "-c", code], "timeoutMs": 3000}))
        self.key = hashlib.sha256(b"immutable-job").hexdigest()
        self.request = {"schema": 1, "operation": "ensure", "key": self.key, "jobId": None, "input": {"value": 42}, "inputHash": "f" * 64}

    def tearDown(self):
        self.tmp.cleanup()

    def call(self, request=None, check=True):
        proc = subprocess.run([sys.executable, str(AGENT), "--root", str(self.root), "--config", str(self.config)],
                              input=json.dumps(request or self.request), text=True, capture_output=True, timeout=5)
        if check:
            self.assertEqual(proc.returncode, 0, proc.stderr)
            return json.loads(proc.stdout)
        return proc

    def done(self):
        for _ in range(100):
            result = self.call({**self.request, "operation": "inspect", "jobId": self.key})
            if result["status"] in ("SUCCEEDED", "FAILED"):
                return result
            time.sleep(0.02)
        self.fail("remote fixture did not complete")

    def test_concurrent_ensure_executes_only_once_and_survives_client_exit(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            replies = list(pool.map(lambda _: self.call(), range(8)))
        self.assertEqual({r["jobId"] for r in replies}, {self.key})
        result = self.done()
        self.assertEqual(result["status"], "SUCCEEDED")
        self.assertEqual(result["result"]["exitCode"], 0)
        self.assertEqual(self.counter.read_text(), "x")
        self.assertEqual(self.call()["status"], "SUCCEEDED")
        self.assertEqual(self.counter.read_text(), "x")

    def test_changed_input_cannot_reuse_existing_job_key(self):
        self.call()
        self.done()
        result = self.call({**self.request, "input": {"value": 7}}, check=False)
        self.assertEqual(result.returncode, 64)
        self.assertEqual(self.counter.read_text(), "x")

    def test_inspect_unknown_never_submits(self):
        result = self.call({**self.request, "operation": "inspect", "jobId": self.key})
        self.assertEqual(result["status"], "UNKNOWN")
        self.assertFalse(self.counter.exists())

    def test_lost_worker_is_unknown_and_not_automatically_reexecuted(self):
        self.call()
        self.done()
        path = self.root / self.key / "state.json"
        path.write_text(json.dumps({"status": "RUNNING", "workerPid": 999999999}))
        self.assertEqual(self.call()["status"], "UNKNOWN")
        self.assertEqual(self.counter.read_text(), "x")

    def test_persisted_state_corruption_is_not_treated_as_an_empty_job(self):
        self.call()
        self.done()
        (self.root / self.key / "state.json").write_text("broken")
        self.assertEqual(self.call(check=False).returncode, 64)
        self.assertEqual(self.counter.read_text(), "x")

    def test_trusted_deadline_kills_job_and_never_reports_success(self):
        self.config.write_text(json.dumps({"argv": [sys.executable, "-c", "import time;time.sleep(5)"], "timeoutMs": 100}))
        self.call()
        result = self.done()
        self.assertEqual(result["status"], "FAILED")
        self.assertNotEqual(result["result"]["exitCode"], 0)

    def test_shell_text_in_input_is_data_not_executed(self):
        self.request["input"] = {"value": f"$(touch {self.base / 'injected'})"}
        self.call()
        self.done()
        self.assertFalse((self.base / "injected").exists())


if __name__ == "__main__":
    unittest.main()
