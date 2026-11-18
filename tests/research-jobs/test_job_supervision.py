"""Real detached-worker recovery, with no transport or model in its control loop."""
import hashlib
import concurrent.futures
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

AGENT = Path(__file__).resolve().parents[2] / "scripts/research-job-agent.py"


class JobSupervisionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.root = self.base / "arbitrary-run-name"
        self.config = self.base / "template.json"
        self.counter = self.base / "attempts"
        self.key = hashlib.sha256(b"resident-supervision").hexdigest()
        self.request = {"schema": 1, "operation": "ensure", "key": self.key,
                        "jobId": None, "input": {"seed": 7}, "inputHash": "b" * 64}

    def tearDown(self):
        self.tmp.cleanup()

    def configure(self, code, supervision=None, **options):
        self.config.write_text(json.dumps({"argv": [sys.executable, "-c", code], "timeoutMs": 3000,
            "supervision": {"replaySafe": True, "maxAttempts": 3, "retryExitCodes": [75],
                            "backoffMs": 20, "pollMs": 20, **(supervision or {})}, **options}))

    def call(self, check=True):
        p = subprocess.run([sys.executable, str(AGENT), "--root", str(self.root), "--config", str(self.config)],
                           input=json.dumps(self.request), capture_output=True, text=True, timeout=5)
        if not check:
            return p
        self.assertEqual(p.returncode, 0, p.stderr)
        return json.loads(p.stdout)

    def complete_without_client(self):
        self.call()
        # No ensure/inspect calls drive recovery; only the remote keeper runs.
        path = self.root / self.key / "state.json"
        for _ in range(500):
            state = json.loads(path.read_text())
            if state["status"] in ("SUCCEEDED", "FAILED"):
                return state
            time.sleep(0.01)
        self.fail("resident worker failed to finish")

    def counting_code(self, suffix):
        return ("import os,json,time;from pathlib import Path;"
                f"p=Path({str(self.counter)!r});p.write_text(p.read_text()+'x' if p.exists() else 'x');" + suffix)

    def test_resident_retry_survives_client_exit_and_keeps_identity(self):
        self.configure(self.counting_code(
            "assert os.environ['FUTURE_JOB_KEY']=='" + self.key + "';"
            "print('attempt-'+os.environ['FUTURE_JOB_ATTEMPT']);"
            "raise SystemExit(75 if len(p.read_text())==1 else 0)"), maxLogBytes=1024)
        state = self.complete_without_client()
        self.assertEqual(state["status"], "SUCCEEDED")
        self.assertEqual(self.counter.read_text(), "xx")
        summary = state["result"]["supervision"]
        self.assertEqual(summary["attempts"], 2)
        self.assertEqual(summary["restarts"], 1)
        self.assertEqual(len(summary["history"]), 2)
        self.assertEqual(self.call()["result"], state["result"])
        self.assertEqual(self.counter.read_text(), "xx")
        # Final cold artifacts still use the existing read_artifact contract.
        request = {"schema": 1, "operation": "read_artifact", "key": self.key,
                   "jobId": self.key, "artifact": "stdout", "offset": 0, "length": 1024}
        p = subprocess.run([sys.executable, str(AGENT), "--root", str(self.root), "--config", str(self.config)],
                           input=json.dumps(request), text=True, capture_output=True, timeout=5)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(json.loads(p.stdout)["sha256"], state["result"]["artifacts"]["stdout"]["sha256"])

    def test_repeated_identical_crashes_stop_after_one_unchanged_retry(self):
        self.configure(self.counting_code("raise SystemExit(75)"))
        state = self.complete_without_client()
        self.assertEqual(state["status"], "FAILED")
        self.assertEqual(self.counter.read_text(), "xx")
        self.assertIn("unchanged", state["result"]["error"])

    def test_nonretryable_exit_and_invalid_evidence_are_never_retried(self):
        for label, suffix, options in [("exit", "raise SystemExit(2)", {}),
                                       ("evidence", "print('PASS')", {"resultMaxBytes": 1024})]:
            with self.subTest(label=label):
                self.key = hashlib.sha256(label.encode()).hexdigest()
                self.request["key"] = self.key
                self.counter = self.base / label
                self.configure(self.counting_code(suffix), **options)
                state = self.complete_without_client()
                self.assertEqual(state["status"], "FAILED")
                self.assertEqual(self.counter.read_text(), "x")

    def test_bootstrap_runs_on_machine_before_every_attempt(self):
        bootstrap_counter = self.base / "bootstrap"
        code = f"from pathlib import Path;p=Path({str(bootstrap_counter)!r});p.write_text(p.read_text()+'b' if p.exists() else 'b')"
        self.configure(self.counting_code("raise SystemExit(75 if len(p.read_text())==1 else 0)"),
            supervision={"bootstrap": {"argv": [sys.executable, "-c", code], "timeoutMs": 1000}})
        self.assertEqual(self.complete_without_client()["status"], "SUCCEEDED")
        self.assertEqual(bootstrap_counter.read_text(), "bb")

    def test_bootstrap_failure_prevents_launch(self):
        self.configure(self.counting_code("pass"), supervision={"bootstrap": {
            "argv": [sys.executable, "-c", "raise SystemExit(9)"], "timeoutMs": 1000}})
        state = self.complete_without_client()
        self.assertEqual(state["status"], "FAILED")
        self.assertFalse(self.counter.exists())
        self.assertIn("bootstrap", state["result"]["error"])

    def test_total_deadline_includes_retry_backoff_and_bootstrap(self):
        self.configure(self.counting_code("time.sleep(.08);raise SystemExit(75)"),
            supervision={"backoffMs": 300}, timeoutMs=250)
        started = time.monotonic()
        state = self.complete_without_client()
        self.assertEqual(state["status"], "FAILED")
        self.assertEqual(self.counter.read_text(), "x")
        self.assertIn("deadline", state["result"]["error"])
        self.assertLess(time.monotonic() - started, 2)

    def test_heartbeat_changes_cannot_mask_a_semantic_stall(self):
        code = ("import os,time,json;from pathlib import Path;p=Path(os.environ['FUTURE_JOB_PROGRESS_PATH']);"
                "exec(\"for i in range(100):\\n p.write_text(json.dumps({'sequence':1,'heartbeat':i}));time.sleep(.02)\")")
        self.configure(code, supervision={"stallMs": 120})
        state = self.complete_without_client()
        self.assertEqual(state["status"], "FAILED")
        self.assertIn("semantic progress", state["result"]["error"])
        self.assertEqual(state["result"]["supervision"]["attempts"], 1)

    def stall_policy(self):
        return {"stallMs": 450, "retryOnStall": True, "retryExitCodes": [], "checkpoint": {
            "root": str(self.base / "checkpoints"), "contract": "d" * 64, "components": ["state"]}}

    def checkpoint_then_stall(self, resume, last_sequence=41):
        return f"""
import json,os,sys,time
from pathlib import Path
sys.path.insert(0, {str(AGENT.parent)!r})
from research_job_checkpoints import publish_bundle
if 'FUTURE_JOB_RESUME_PATH' not in os.environ:
    source = Path.cwd() / 'source'
    source.mkdir()
    (source / 'state').write_text('41')
    publish_bundle(Path(os.environ['FUTURE_JOB_CHECKPOINT_ROOT']), source, 41,
                   os.environ['FUTURE_JOB_CHECKPOINT_CONTRACT'], {{'state': {{'path': 'state', 'step': 41}}}})
    Path(os.environ['FUTURE_JOB_PROGRESS_PATH']).write_text(json.dumps({{'sequence': {last_sequence}}}))
    time.sleep(15)
else:
    assert int(os.environ['FUTURE_JOB_RESUME_STEP']) == 41
    value = int((Path(os.environ['FUTURE_JOB_RESUME_PATH']) / 'state').read_text())
    {resume}
"""

    def test_authorized_stall_retry_resumes_complete_checkpoint_without_a_client(self):
        self.configure(self.checkpoint_then_stall(
            "Path(os.environ['FUTURE_JOB_RESULT_PATH']).write_text(json.dumps({'value': value + 1}))"),
            supervision=self.stall_policy(), resultMaxBytes=512)
        state = self.complete_without_client()
        self.assertEqual(state["status"], "SUCCEEDED", state)
        self.assertEqual(state["result"]["data"], {"value": 42})
        self.assertEqual([h["resumeStep"] for h in state["result"]["supervision"]["history"]], [None, 41])
        receipt = json.loads((self.root / self.key / "attempts/1/receipt.json").read_text())
        self.assertEqual(receipt["exitCode"], -signal.SIGKILL)
        self.assertIn("semantic progress", receipt["error"])

    def test_unchanged_stall_at_same_checkpoint_stops_after_one_retry(self):
        self.configure(self.checkpoint_then_stall("time.sleep(15)"), supervision=self.stall_policy())
        state = self.complete_without_client()
        self.assertEqual(state["status"], "FAILED", state)
        self.assertEqual([h["resumeStep"] for h in state["result"]["supervision"]["history"]], [None, 41])
        self.assertIn("unchanged", state["result"]["error"])

    def test_healthy_checkpoint_catchup_can_exceed_one_stall_interval(self):
        resume = """for step in range(value + 1, 49):
        Path(os.environ['FUTURE_JOB_PROGRESS_PATH']).write_text(json.dumps({'sequence': step}))
        time.sleep(.15)
    Path(os.environ['FUTURE_JOB_RESULT_PATH']).write_text(json.dumps({'value': step}))"""
        self.configure(self.checkpoint_then_stall(resume, last_sequence=47),
                       supervision=self.stall_policy(), resultMaxBytes=512, timeoutMs=6000)
        state = self.complete_without_client()
        self.assertEqual(state["status"], "SUCCEEDED", state)
        self.assertEqual(state["result"]["data"], {"value": 48})
        self.assertEqual(state["result"]["supervision"]["lastSequence"], 48)
        self.assertEqual(self.call()["progressToken"], "48")

    def test_replayed_milestones_do_not_publish_goal_or_global_progress(self):
        sys.path.insert(0, str(AGENT.parent))
        try:
            from research_job_supervision import Progress
        finally:
            sys.path.pop(0)
        policy = {"goal": {"name": "score", "contract": "d" * 64, "direction": "maximize",
                           "baseline": 0, "staleMs": 30000}}
        progress = Progress(self.base / "progress.json", policy)

        def write(sequence, value, contract="d" * 64):
            progress.path.write_text(json.dumps({"sequence": sequence, "metric": {"name": "score",
                "contract": contract, "samples": 1, "value": value}}))
            progress.observe()

        write(46, .5)
        progress.path.write_text('{"sequence":47}')
        progress.observe()
        goal, measured_at = progress.goal(), progress.metric_at
        progress.resume_from(self.base / "resumed-progress.json", 41)
        progress.advanced = 0
        write(41, 1)  # The saved step is the lower bound for the resumed attempt.
        self.assertEqual(progress.advanced, 0)
        write(42, 1)
        self.assertGreater(progress.advanced, 0)
        progress.advanced = 0
        for sequence in (41, 42, "invalid", 42):
            write(sequence, 1, "e" * 64)
        self.assertEqual(progress.advanced, 0)
        write(43, 10, "e" * 64)
        write(47, 20)  # The previous high-water step lacked a metric.
        self.assertEqual((progress.sequence, progress.metric_at, progress.goal()), (47, measured_at, goal))
        write(48, .75)
        self.assertEqual(progress.sequence, 48)
        self.assertEqual(progress.goal()["value"], .75)
        # A completed save may precede publication of its progress record.
        progress.resume_from(self.base / "next-attempt.json", 50)
        write(50, 1)
        self.assertEqual((progress.sequence, progress.goal()["value"]), (48, .75))

    def test_stall_retry_keeps_original_deadline_and_requires_explicit_authority(self):
        for cause in ("deadline", "stall"):
            with self.subTest(cause=cause):
                self.key = hashlib.sha256(cause.encode()).hexdigest()
                self.request["key"] = self.key
                policy = {**self.stall_policy(), "retryExitCodes": [-signal.SIGKILL]}
                if cause == "deadline":
                    policy["stallMs"] = 2000
                else:
                    del policy["retryOnStall"]
                self.configure(self.checkpoint_then_stall("raise AssertionError('unexpected replay')"),
                               supervision=policy, timeoutMs=1200)
                state = self.complete_without_client()
                self.assertEqual(state["status"], "FAILED", state)
                expected = "trusted job deadline" if cause == "deadline" else "semantic progress deadline"
                self.assertIn(expected, state["result"]["error"])
                self.assertEqual(state["result"]["supervision"]["attempts"], 1)

    def test_stall_without_a_valid_checkpoint_never_restarts_cold(self):
        self.configure(self.counting_code("time.sleep(15)"), supervision=self.stall_policy())
        state = self.complete_without_client()
        self.assertEqual(state["status"], "FAILED", state)
        self.assertIn("checkpoint", state["result"]["error"])
        self.assertEqual(self.counter.read_text(), "x")

    def test_lost_owner_remains_unknown_even_with_recovery_enabled(self):
        self.configure("print('finished')")
        self.complete_without_client()
        path = self.root / self.key / "state.json"
        path.write_text(json.dumps({"status": "RUNNING", "workerPid": 999999999}))
        self.assertEqual(self.call()["status"], "UNKNOWN")

    def test_goal_metric_is_separate_from_steps_and_requires_matching_contract(self):
        contract = "c" * 64
        progress = {"sequence": 17, "metric": {"name": "heldout_score", "contract": contract,
                    "value": .2, "samples": 68}}
        self.configure("import os,json;from pathlib import Path;"
            f"Path(os.environ['FUTURE_JOB_PROGRESS_PATH']).write_text({json.dumps(progress)!r})",
            supervision={"goal": {"name": "heldout_score", "contract": contract, "direction": "maximize",
                                   "baseline": .2, "staleMs": 1000}})
        state = self.complete_without_client()
        summary = state["result"]["supervision"]
        self.assertEqual(summary["lastSequence"], 17)
        self.assertEqual(summary["goal"]["delta"], 0)
        self.assertEqual(summary["goal"]["status"], "UNCHANGED")
        self.assertEqual(summary["goal"]["trust"], "OBSERVATION_NOT_ACCEPTANCE")

    def test_missing_checkpoint_blocks_cold_restart(self):
        self.configure(self.counting_code("raise SystemExit(75)"), supervision={"checkpoint": {
            "root": str(self.base / "checkpoints"), "contract": "d" * 64, "components": ["state", "weights"]}})
        state = self.complete_without_client()
        self.assertEqual(state["status"], "FAILED")
        self.assertEqual(self.counter.read_text(), "x")
        self.assertIn("checkpoint", state["result"]["error"])

    def test_real_resume_uses_one_complete_generation_and_preserves_results(self):
        checkpoint_root = self.base / "checkpoint-store"
        contract = "e" * 64
        code = f"""
import os,sys,json
from pathlib import Path
sys.path.insert(0, {str(AGENT.parent)!r})
from research_job_checkpoints import publish_bundle
p=Path({str(self.counter)!r})
p.write_text(p.read_text()+'x' if p.exists() else 'x')
root=Path(os.environ['FUTURE_JOB_CHECKPOINT_ROOT'])
if len(p.read_text())==1:
    source=p.parent/'save'
    source.mkdir()
    (source/'weights').write_text('2')
    (source/'state').write_text(json.dumps({{'step':2,'value':2}}))
    publish_bundle(root, source, 2, os.environ['FUTURE_JOB_CHECKPOINT_CONTRACT'],
        {{'weights':{{'path':'weights','step':2}},'state':{{'path':'state','step':2}}}})
    # Interrupted newer save has no complete generation manifest.
    partial=root/'new-unrecognized-run-name'
    partial.mkdir()
    (partial/'weights').write_text('4')
    raise SystemExit(75)
resume=Path(os.environ['FUTURE_JOB_RESUME_PATH'])
state=json.loads((resume/'state').read_text())
assert int(os.environ['FUTURE_JOB_RESUME_STEP'])==state['step']==2
assert int((resume/'weights').read_text())==state['value']==2
for step in range(state['step']+1,6):
    state['value']+=1
Path(os.environ['FUTURE_JOB_RESULT_PATH']).write_text(json.dumps({{'value':state['value'],'step':5}}))
"""
        self.configure(code, supervision={"checkpoint": {"root": str(checkpoint_root), "contract": contract,
                       "components": ["weights", "state"]}}, resultMaxBytes=1024)
        state = self.complete_without_client()
        self.assertEqual(state["status"], "SUCCEEDED", state)
        self.assertEqual(state["result"]["data"], {"value": 5, "step": 5})
        self.assertEqual(self.counter.read_text(), "xx")
        self.assertEqual([h["resumeStep"] for h in state["result"]["supervision"]["history"]], [None, 2])
        self.assertTrue((self.root / self.key / "attempts/1/receipt.json").exists())

    def test_shared_checkpoint_template_never_adopts_another_job(self):
        code = f"""
import os,sys
from pathlib import Path
sys.path.insert(0, {str(AGENT.parent)!r})
from research_job_checkpoints import publish_bundle
assert 'FUTURE_JOB_RESUME_PATH' not in os.environ, 'cross-job checkpoint contamination'
root=Path(os.environ['FUTURE_JOB_CHECKPOINT_ROOT'])
source=Path(os.environ['FUTURE_JOB_INPUT_PATH']).parent/'save'
source.mkdir()
(source/'state').write_text('1')
publish_bundle(root,source,1,os.environ['FUTURE_JOB_CHECKPOINT_CONTRACT'],{{'state':{{'path':'state','step':1}}}})
"""
        self.configure(code, supervision={"checkpoint": {"root": str(self.base / "shared-checkpoints"),
                         "contract": "a" * 64, "components": ["state"]}})
        first_key = self.key
        self.assertEqual(self.complete_without_client()["status"], "SUCCEEDED")
        self.key = hashlib.sha256(b"other-input-or-seed").hexdigest()
        self.request["key"] = self.key
        self.request["input"] = {"seed": 19}
        self.assertEqual(self.complete_without_client()["status"], "SUCCEEDED")
        self.assertTrue((self.base / "shared-checkpoints" / first_key).is_dir())
        self.assertTrue((self.base / "shared-checkpoints" / self.key).is_dir())

    def test_concurrent_clients_during_recovery_do_not_duplicate_work(self):
        self.configure(self.counting_code("time.sleep(.1);raise SystemExit(75 if len(p.read_text())==1 else 0)"),
                       supervision={"backoffMs": 150})
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            replies = list(pool.map(lambda _: self.call(), range(8)))
        self.assertEqual({r["jobId"] for r in replies}, {self.key})
        state = self.complete_without_client()
        self.assertEqual(state["status"], "SUCCEEDED")
        self.assertEqual(self.counter.read_text(), "xx")

    def test_unsafe_or_unbounded_recovery_config_is_rejected_before_execution(self):
        for change in ({"replaySafe": False}, {"maxAttempts": 0}, {"retryExitCodes": [0]},
                       {"retryExitCodes": []}, {"retryOnStall": True}, {"retryOnStall": 1},
                       {"stallMs": 100, "retryOnStall": True},
                       {"maxAttempts": True}, {"bootstrap": {"argv": ["python3"], "timeoutMs": 1000}},
                       {"checkpoint": {"root": "/tmp/checkpoints", "contract": "a" * 64,
                                       "components": ["manifest.json"]}},
                       {"checkpoint": {"root": "/tmp/checkpoints", "contract": "a" * 64,
                                       "components": [f"c{i}" for i in range(33)]}}):
            with self.subTest(change=change):
                self.configure("print('must not run')", supervision=change)
                self.assertEqual(self.call(check=False).returncode, 64)
                self.assertFalse(self.root.exists())

    def test_reported_goal_tracks_current_regressions_and_rejects_bad_telemetry(self):
        sys.path.insert(0, str(AGENT.parent))
        try:
            from research_job_supervision import Progress
        finally:
            sys.path.pop(0)
        path = self.base / "progress.json"
        policy = {"goal": {"name": "score", "contract": "f" * 64, "direction": "maximize",
                           "baseline": .2, "staleMs": 1000}}
        p = Progress(path, policy)
        def observe(sequence, value, contract="f" * 64):
            path.write_text(json.dumps({"sequence": sequence, "metric": {"name": "score", "contract": contract,
                                                                       "value": value, "samples": 68}}))
            p.observe()
        observe(1, .8)
        observe(2, .1)
        self.assertEqual(p.goal()["status"], "REGRESSED")
        self.assertAlmostEqual(p.goal()["delta"], -.1)
        self.assertAlmostEqual(p.goal()["bestDelta"], .6)
        observe(3, 1, "a" * 64)
        self.assertEqual(p.goal()["status"], "INVALID")
        observe(4, 10**500)
        self.assertEqual(p.goal()["status"], "INVALID")
        path.write_text('{"sequence":5,"bad":' + '['*10000 + '0' + ']'*10000 + '}')
        p.observe()  # malformed telemetry must never crash the keeper
        path.unlink()
        path.symlink_to(self.base / "missing")
        p.observe()
        self.assertEqual(p.sequence, 4)
        path.unlink()
        os.mkfifo(path)
        p.observe()  # must not block on telemetry FIFOs
        path.unlink()
        policy["goal"]["baseline"] = 1e308
        p = Progress(path, policy)
        observe(1, -1e308)
        self.assertEqual(p.goal()["status"], "INVALID")
        self.assertIsNone(p.goal()["delta"])

    def test_telemetry_stale_clock_is_not_renewed_by_new_steps(self):
        sys.path.insert(0, str(AGENT.parent))
        try:
            from research_job_supervision import Progress
        finally:
            sys.path.pop(0)
        path = self.base / "progress.json"
        policy = {"goal": {"name": "score", "contract": "f" * 64, "direction": "minimize",
                           "baseline": 10, "staleMs": 100}}
        p = Progress(path, policy)
        path.write_text(json.dumps({"sequence": 1, "metric": {"name": "score", "contract": "f" * 64,
                                                            "value": 8, "samples": 10}}))
        p.observe()
        self.assertEqual(p.goal()["delta"], 2)
        p.metric_at -= 1
        path.write_text('{"sequence":2}')
        p.observe()
        self.assertEqual(p.sequence, 2)
        self.assertEqual(p.goal()["status"], "STALE")


if __name__ == "__main__":
    unittest.main()
