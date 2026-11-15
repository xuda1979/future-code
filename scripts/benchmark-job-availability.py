#!/usr/bin/env python3
"""Offline paired crash-recovery experiment, not an LLM/model quality benchmark.

Compare a repository revision's one-shot endpoint with the current resident
worker on the same six-unit workload, interrupted after unit two. Neither arm
receives an inspect/poll RPC after launch. All numbers come from actual jobs.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
CONTRACT = hashlib.sha256(b"offline-six-unit-recovery-v1").hexdigest()
WORKLOAD = """
import json,os,sys,time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from research_job_checkpoints import publish_bundle
data=json.loads(Path(os.environ['FUTURE_JOB_INPUT_PATH']).read_text())
root=Path(data['root'])
events=root/'events.jsonl'
def event(kind, **fields):
    with events.open('a') as out:
        out.write(json.dumps(dict(kind=kind,at=time.monotonic(),**fields))+'\\n')
resume=os.environ.get('FUTURE_JOB_RESUME_PATH')
step=int((Path(resume)/'state').read_text()) if resume else 0
event('start',step=step)
for step in range(step+1,7):
    time.sleep(.02)
    event('unit',step=step)
    Path(os.environ['FUTURE_JOB_PROGRESS_PATH']).write_text(json.dumps(dict(sequence=step)))
    if step==2 and not resume:
        source=root/'source'
        source.mkdir()
        (source/'state').write_text(str(step))
        publish_bundle(Path(os.environ.get('FUTURE_JOB_CHECKPOINT_ROOT', str(root/'checkpoints'))),
            source,step,data['contract'],dict(state=dict(path='state',step=step)))
        event('crash',step=step)
        raise SystemExit(75)
event('complete',step=step)
"""


def run_arm(base, endpoint, supervised):
    base.mkdir()
    job_root = base / "spool"
    workload = base / "workload.py"
    workload.write_text(WORKLOAD)
    cfg = {"argv": [sys.executable, str(workload), str(SCRIPTS)], "timeoutMs": 5000}
    if supervised:
        cfg["supervision"] = {"replaySafe": True, "maxAttempts": 3, "retryExitCodes": [75],
            "backoffMs": 20, "pollMs": 20, "checkpoint": {"root": str(base / "checkpoints"),
            "contract": CONTRACT, "components": ["state"]}}
    config = base / "template.json"
    config.write_text(json.dumps(cfg))
    key = hashlib.sha256(str(base).encode()).hexdigest()
    request = {"schema": 1, "operation": "ensure", "key": key, "jobId": None,
               "input": {"root": str(base), "contract": CONTRACT}, "inputHash": CONTRACT}
    started = time.monotonic()
    p = subprocess.run([sys.executable, str(endpoint), "--root", str(job_root), "--config", str(config)],
                       input=json.dumps(request), text=True, capture_output=True, timeout=5)
    if p.returncode:
        raise RuntimeError(p.stderr)
    for _ in range(700):
        state = json.loads((job_root / key / "state.json").read_text())
        if state["status"] in ("SUCCEEDED", "FAILED"):
            break
        time.sleep(.01)
    else:
        raise RuntimeError("job did not reach a terminal state")
    events = [json.loads(line) for line in (base / "events.jsonl").read_text().splitlines()]
    starts = [e for e in events if e["kind"] == "start"]
    crash = next(e for e in events if e["kind"] == "crash")
    return {"status": state["status"], "completedUnits": max(e.get("step", 0) for e in events),
            "attempts": len(starts), "resumeSteps": [e["step"] for e in starts],
            "timeToTerminalMs": round((time.monotonic() - started) * 1000, 2),
            "recoveryGapMs": round((starts[1]["at"] - crash["at"]) * 1000, 2) if len(starts) > 1 else None,
            "exitCode": state["result"]["exitCode"], "inspectionRPCs": 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-revision", required=True)
    parser.add_argument("--trials", type=int, default=5)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not 1 <= args.trials <= 30:
        parser.error("trials must be 1 to 30")
    revision = subprocess.check_output(["git", "rev-parse", "--verify", args.baseline_revision + "^{commit}"], cwd=ROOT, text=True).strip()
    baseline = subprocess.check_output(["git", "show", revision + ":scripts/research-job-agent.py"], cwd=ROOT)
    with tempfile.TemporaryDirectory(prefix="future-availability-") as tmp:
        temp = Path(tmp)
        endpoint = temp / "baseline-agent.py"
        endpoint.write_bytes(baseline)
        pairs = []
        for trial in range(args.trials):
            control = run_arm(temp / f"control-{trial}", endpoint, False)
            treatment = run_arm(temp / f"resident-{trial}", SCRIPTS / "research-job-agent.py", True)
            if control["status"] != "FAILED" or control["completedUnits"] != 2 or control["attempts"] != 1:
                raise RuntimeError("baseline did not reproduce the declared failure")
            if treatment["status"] != "SUCCEEDED" or treatment["completedUnits"] != 6 or treatment["resumeSteps"] != [0, 2]:
                raise RuntimeError("resident treatment did not meet the declared recovery contract")
            pairs.append({"trial": trial + 1, "baseline": control, "resident": treatment})
    files = ["scripts/research-job-agent.py", "scripts/research_job_supervision.py", "scripts/research_job_checkpoints.py"]
    report = {"schema": 1, "measuredAt": datetime.now(timezone.utc).isoformat(),
        "classification": "MEASURED_OFFLINE_PROCESS_RECOVERY_NOT_LIVE_LLM_OR_MODEL_BENCHMARK",
        "baselineCommit": revision, "baselineEndpointSha256": hashlib.sha256(baseline).hexdigest(),
        "sourceSha256": {f: hashlib.sha256((ROOT / f).read_bytes()).hexdigest() for f in files},
        "python": sys.version.split()[0], "protocol": {"units": 6, "crashAfterUnit": 2,
            "failureExitCode": 75, "unitMs": 20, "postLaunchInspectionRPCs": 0,
            "baselineRecovery": "terminal failure, no automatic recovery; recovery latency unmeasured",
            "metric": "workload completion, not model accuracy"},
        "trials": pairs, "summary": {"baselineCompletions": 0, "residentCompletions": len(pairs),
            "medianResidentRecoveryGapMs": statistics.median(p["resident"]["recoveryGapMs"] for p in pairs)}}
    rendered = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered)
    print(rendered, end="")


if __name__ == "__main__":
    main()
