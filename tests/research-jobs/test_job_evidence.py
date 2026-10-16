"""Structured remote results and bounded cold evidence; no model/API needed."""
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

AGENT = Path(__file__).resolve().parents[2] / "scripts/research-job-agent.py"


class JobEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.root = self.base / "spool"
        self.config = self.base / "template.json"
        self.key = hashlib.sha256(b"structured-job").hexdigest()
        self.request = {"schema": 1, "operation": "ensure", "key": self.key,
                        "jobId": None, "input": {"trial": 1}, "inputHash": "a" * 64}

    def tearDown(self):
        self.tmp.cleanup()

    def configure(self, code, **options):
        self.config.write_text(json.dumps({"argv": [sys.executable, "-c", code],
                                          "timeoutMs": 3000, **options}))

    def call(self, request=None, check=True):
        proc = subprocess.run([sys.executable, str(AGENT), "--root", str(self.root),
                               "--config", str(self.config)], input=json.dumps(request or self.request),
                              text=True, capture_output=True, timeout=5)
        if check:
            self.assertEqual(proc.returncode, 0, proc.stderr)
            return json.loads(proc.stdout)
        return proc

    def complete(self):
        self.call()
        for _ in range(100):
            reply = self.call({**self.request, "operation": "inspect", "jobId": self.key})
            if reply["status"] in ("SUCCEEDED", "FAILED"):
                return reply
            time.sleep(0.02)
        self.fail("job did not complete")

    def artifact(self, name, **options):
        return self.call({"schema": 1, "operation": "read_artifact", "key": self.key,
                          "jobId": self.key, "artifact": name, **options})

    def test_structured_result_is_exact_and_does_not_scrape_stdout(self):
        data = {"metrics": {"score": 0.87, "samples": 12}, "note": "数学", "passed": False}
        raw = json.dumps(data, ensure_ascii=False).encode()
        self.configure("import os;from pathlib import Path;"
                       f"Path(os.environ['FUTURE_JOB_RESULT_PATH']).write_bytes({raw!r});"
                       "print('score=1.0 PASS: this text is not a result')", resultMaxBytes=4096)
        reply = self.complete()
        self.assertEqual(reply["status"], "SUCCEEDED")
        self.assertEqual(reply["result"]["data"], data)
        manifest = reply["result"]["artifacts"]["result"]
        self.assertEqual(manifest["sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(manifest["bytes"], len(raw))
        page = self.artifact("result", offset=0, length=7)
        self.assertEqual(base64.b64decode(page["contentBase64"]), raw[:7])
        self.assertEqual(page["nextOffset"], 7)
        self.assertEqual(self.call()["result"], reply["result"])

    def test_missing_malformed_duplicate_nonfinite_and_oversized_result_fail_closed(self):
        for label, raw in [("missing", None), ("malformed", b"```json\n{}\n```"),
                           ("duplicate", b'{"score":1,"score":0}'),
                           ("nonfinite", b'{"score":NaN}'), ("overflow", b'{"score":1e999}'),
                           ("scalar", b'42'), ("oversized", b'{"x":"' + b'x' * 100 + b'"}')]:
            with self.subTest(label=label):
                self.key = hashlib.sha256(label.encode()).hexdigest()
                self.request["key"] = self.key
                code = "print('successful exit is not sufficient')" if raw is None else (
                    "import os;from pathlib import Path;"
                    f"Path(os.environ['FUTURE_JOB_RESULT_PATH']).write_bytes({raw!r})")
                self.configure(code, resultMaxBytes=64)
                reply = self.complete()
                self.assertEqual(reply["status"], "FAILED")
                self.assertEqual(reply["result"]["exitCode"], 0)
                self.assertIn("structured result", reply["result"]["error"])
                self.assertNotIn("data", reply["result"])

    def test_result_cannot_be_a_symlink_or_fifo(self):
        for kind in ("symlink", "fifo"):
            with self.subTest(kind=kind):
                self.key = hashlib.sha256(kind.encode()).hexdigest()
                self.request["key"] = self.key
                target = self.base / "outside.json"
                target.write_text('{"score":1}')
                code = "import os;p=os.environ['FUTURE_JOB_RESULT_PATH'];" + (
                    f"os.symlink({str(target)!r},p)" if kind == "symlink" else "os.mkfifo(p)")
                self.configure(code, resultMaxBytes=1024)
                reply = self.complete()
                self.assertEqual(reply["status"], "FAILED")
                self.assertNotIn("data", reply["result"])

    def test_log_capture_is_bounded_but_counts_and_hashes_the_observed_stream(self):
        raw = ("αβ\n" * 20000).encode()
        self.configure("import os;os.write(1,('αβ\\n'*20000).encode());os.write(2,b'diagnostic')", maxLogBytes=31)
        reply = self.complete()
        self.assertEqual(reply["status"], "SUCCEEDED")
        meta = reply["result"]["artifacts"]["stdout"]
        self.assertEqual(meta["bytes"], 31)
        self.assertEqual(meta["observedBytes"], len(raw))
        self.assertTrue(meta["truncated"])
        self.assertEqual(meta["sha256"], hashlib.sha256(raw[:31]).hexdigest())
        self.assertEqual(meta["observedSha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual((self.root / self.key / "stdout.bin").stat().st_size, 31)
        page = self.artifact("stdout", length=8192)
        self.assertEqual(base64.b64decode(page["contentBase64"]), raw[:31])
        self.assertIsNone(page["nextOffset"])
        self.assertLess(len(json.dumps(reply)), 16000)

    def test_nonzero_exit_cannot_be_overridden_by_structured_claims(self):
        self.configure("import os;from pathlib import Path;"
                       "Path(os.environ['FUTURE_JOB_RESULT_PATH']).write_text('{\"passed\":true}');"
                       "raise SystemExit(7)", resultMaxBytes=1024)
        reply = self.complete()
        self.assertEqual(reply["status"], "FAILED")
        self.assertEqual(reply["result"]["exitCode"], 7)
        self.assertEqual(reply["result"]["data"], {"passed": True})

    def test_artifact_reads_are_terminal_bounded_and_detect_tampering(self):
        self.configure("print('artifact bytes')", maxLogBytes=1024)
        self.complete()
        for change in ({"artifact": "../state.json"}, {"offset": -1}, {"length": 8193}):
            request = {"schema": 1, "operation": "read_artifact", "key": self.key,
                       "jobId": self.key, "artifact": "stdout", **change}
            self.assertEqual(self.call(request, check=False).returncode, 64)
        request = {"schema": 1, "operation": "read_artifact", "key": self.key,
                   "jobId": self.key, "artifact": "stdout"}
        evidence = self.root / self.key / "stdout.bin"
        size = evidence.stat().st_size
        for raw in (b"x" * size, b"changed"):
            evidence.write_bytes(raw)
            self.assertEqual(self.call(request, check=False).returncode, 64)

    def test_reserved_environment_and_invalid_budgets_are_rejected_before_execution(self):
        for options in ({"resultMaxBytes": True}, {"resultMaxBytes": 0}, {"resultMaxBytes": 65537},
                        {"maxLogBytes": -1}, {"maxLogBytes": 268435457},
                        {"envAllow": ["FUTURE_JOB_RESULT_PATH"]}):
            with self.subTest(options=options):
                self.configure("print('must not run')", **options)
                self.assertEqual(self.call(check=False).returncode, 64)
                self.assertFalse(self.root.exists())

    def test_legacy_templates_keep_tail_only_behavior(self):
        self.configure("print('legacy')")
        reply = self.complete()
        self.assertEqual(reply["status"], "SUCCEEDED")
        self.assertNotIn("artifacts", reply["result"])
        self.assertNotIn("data", reply["result"])
        self.assertFalse((self.root / self.key / "stdout.bin").exists())

    def test_named_raw_artifacts_are_snapshotted_and_reads_detect_tampering(self):
        raw = bytes(range(256)) * 40
        self.configure("import os;from pathlib import Path;"
                       f"Path(os.environ['FUTURE_JOB_ARTIFACT_DIR'],'raw-data').write_bytes({raw!r})",
                       artifacts={"raw-data": {"maxBytes": 20000}})
        reply = self.complete()
        self.assertEqual(reply["status"], "SUCCEEDED")
        meta = reply["result"]["artifacts"]["raw-data"]
        self.assertEqual(meta, {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)})
        (self.root / self.key / "outputs/raw-data").write_bytes(b"later child-output mutation")
        page = self.artifact("raw-data", offset=8100, length=1000)
        self.assertEqual(base64.b64decode(page["contentBase64"]), raw[8100:9100])
        (self.root / self.key / "raw-data.bin").write_bytes(b"x" * len(raw))
        self.assertEqual(self.call({"schema": 1, "operation": "read_artifact", "key": self.key,
                                   "jobId": self.key, "artifact": "raw-data"}, check=False).returncode, 64)

    def test_missing_oversized_and_nonregular_named_artifacts_fail_closed(self):
        outside = self.base / "external"
        outside.write_bytes(b"external")
        actions = {"missing": "pass", "oversized": "p.write_bytes(b'x'*33)",
                   "symlink": f"p.symlink_to({str(outside)!r})", "fifo": "os.mkfifo(p)"}
        for label, action in actions.items():
            with self.subTest(label=label):
                self.key = hashlib.sha256(label.encode()).hexdigest()
                self.request["key"] = self.key
                self.configure("import os;from pathlib import Path;p=Path(os.environ['FUTURE_JOB_ARTIFACT_DIR'],'raw');" + action,
                               artifacts={"raw": {"maxBytes": 32}})
                reply = self.complete()
                self.assertEqual(reply["status"], "FAILED")
                self.assertNotIn("raw", reply["result"].get("artifacts", {}))

    def test_named_artifact_paths_and_total_budgets_are_operator_bounded(self):
        for artifacts in [{"../escape": {"maxBytes": 12}}, {"result": {"maxBytes": 12}},
                          {"constructor": {"maxBytes": 12}}, {"raw": {"maxBytes": True}},
                          {"raw": {"maxBytes": 0}}, {"raw": {"maxBytes": 12, "path": "/tmp/escape"}},
                          {"a": {"maxBytes": 268435456}, "b": {"maxBytes": 1}}]:
            with self.subTest(artifacts=artifacts):
                self.configure("print('must not run')", artifacts=artifacts)
                self.assertEqual(self.call(check=False).returncode, 64)
                self.assertFalse(self.root.exists())


if __name__ == "__main__":
    unittest.main()
