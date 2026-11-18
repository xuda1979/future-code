#!/usr/bin/env python3
"""Compare detached job recovery on a caller-supplied record checker.

Pass JSONL files and a deterministic command taking one JSON file as its last
argument. The reference executes every input independently. All arms use the
same input bytes, checker, checkpoint interval, attempt limit and wall budget.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time


def digest(data):
    return hashlib.sha256(data).hexdigest()


def check_record(command, records, index):
    filename = f"record-{index:05d}.json"
    source = (records / filename).read_bytes()
    output = subprocess.check_output([*command, filename], cwd=records, timeout=10)
    return [digest(source), digest(output)]


def worker(scripts):
    sys.path.insert(0, str(scripts))
    from research_job_checkpoints import publish_bundle

    params = json.loads(Path(os.environ["FUTURE_JOB_INPUT_PATH"]).read_text())
    records, trial = Path(params["records"]), Path(params["trial"])
    progress = Path(os.environ["FUTURE_JOB_PROGRESS_PATH"])
    resume = os.environ.get("FUTURE_JOB_RESUME_PATH")
    receipts = json.loads((Path(resume) / "receipts").read_text()) if resume else []
    start = int(os.environ.get("FUTURE_JOB_RESUME_STEP", 0))
    if len(receipts) != start:
        raise ValueError("resume cursor does not match checkpoint contents")
    for index in range(start + 1, params["count"] + 1):
        receipt = check_record(params["command"], records, index)
        receipts.append(receipt)
        with (trial / "executed.jsonl").open("a") as log:
            log.write(json.dumps([index, *receipt]) + "\n")
        temp = progress.with_suffix(".tmp")
        temp.write_text(json.dumps({"sequence": index}))
        os.replace(temp, progress)
        if index == params["checkpoint"] and not resume:
            (trial / "receipts").write_text(json.dumps(receipts))
            publish_bundle(Path(os.environ["FUTURE_JOB_CHECKPOINT_ROOT"]), trial, index,
                           os.environ["FUTURE_JOB_CHECKPOINT_CONTRACT"],
                           {"receipts": {"path": "receipts", "step": index}})
            if params["stall"]:
                time.sleep(120)
    Path(os.environ["FUTURE_JOB_RESULT_PATH"]).write_text(json.dumps({"receipts": receipts}))


def run_trial(trial, runtime, params, expected, enable):
    trial.mkdir()
    cfg = {"replaySafe": True, "maxAttempts": 3, "retryExitCodes": [-9, 75],
           "backoffMs": 20, "pollMs": 25, "stallMs": 1000,
           "checkpoint": {"root": str(trial / "checkpoints"),
                          "contract": digest(json.dumps(expected).encode()), "components": ["receipts"]}}
    if enable:
        cfg["retryOnStall"] = True
    template = trial / "template.json"
    template.write_text(json.dumps({"argv": [sys.executable, str(Path(__file__).resolve()), "--worker", str(runtime / "scripts")],
                                    "timeoutMs": 30_000, "resultMaxBytes": 65536, "supervision": cfg}))
    key = digest(str(trial).encode())
    request = {"schema": 1, "operation": "ensure", "key": key, "jobId": None,
               "inputHash": cfg["checkpoint"]["contract"], "input": {**params, "trial": str(trial)}}
    spool = trial / "spool"
    started = time.monotonic()
    ack = subprocess.run([sys.executable, str(runtime / "scripts/research-job-agent.py"), "--config", str(template),
                          "--root", str(spool)], input=json.dumps(request), capture_output=True, text=True,
                         check=True, timeout=10)
    if json.loads(ack.stdout)["jobId"] != key:
        raise RuntimeError("wrong launch acknowledgement")
    # The observer only reads the spool. Neither recovery nor verification sends another RPC.
    while time.monotonic() - started < 40:
        state = json.loads((spool / key / "state.json").read_text())
        if state["status"] in ("SUCCEEDED", "FAILED"):
            break
        time.sleep(.025)
    else:
        raise RuntimeError("trial exceeded its wall budget")
    elapsed = round((time.monotonic() - started) * 1000)
    executed = [json.loads(line) for line in (trial / "executed.jsonl").read_text().splitlines()]
    count = len(executed)
    should_finish = enable or not params["stall"]
    expected_count = params["count"] if should_finish else params["checkpoint"]
    result = state["result"]
    history = result["supervision"]["history"]
    offsets = [attempt["resumeStep"] for attempt in history]
    if (count != expected_count or executed != [[i, *v] for i, v in enumerate(expected[:count], 1)]
            or state["status"] != ("SUCCEEDED" if should_finish else "FAILED")
            or offsets != ([None, params["checkpoint"]] if enable and params["stall"] else [None])):
        raise RuntimeError(f"unexpected execution in {trial.name}: {count=}, {offsets=}, {state=}")
    if should_finish and result["data"]["receipts"] != expected:
        raise RuntimeError("final result differs from independent uninterrupted reference")
    if params["stall"] and history[0]["exitCode"] != -9:
        raise RuntimeError("declared watchdog fault did not occur")
    return {"status": state["status"], "checkedRecords": count, "elapsedMs": elapsed, "resumeOffsets": offsets}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--jsonl", action="append", type=Path, required=True)
    parser.add_argument("--checkpoint", required=True, type=int)
    parser.add_argument("--pairs", type=int, default=5)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command or args.pairs < 1:
        parser.error("provide a checker command and at least one pair")
    with tempfile.TemporaryDirectory(prefix="record-recovery-") as tmp:
        root = Path(tmp)
        records = root / "inputs"
        records.mkdir()
        rows = [line for path in args.jsonl for line in path.read_bytes().splitlines() if line.strip()]
        if not 0 < args.checkpoint < len(rows):
            parser.error("checkpoint must be inside the input sequence")
        for i, raw in enumerate(rows, 1):
            json.loads(raw)
            (records / f"record-{i:05d}.json").write_bytes(raw)
        expected = [check_record(command, records, i) for i in range(1, len(rows) + 1)]
        params = {"command": command, "records": str(records), "count": len(rows), "checkpoint": args.checkpoint}
        arms = [("main", args.baseline.resolve(), False), ("pr", args.candidate.resolve(), True)]
        for i in range(args.pairs):
            for stall in (False, True):
                for arm, runtime, enable in (arms if (i + int(stall)) % 2 == 0 else reversed(arms)):
                    row = run_trial(root / f"{i}-{arm}-{stall}", runtime, {**params, "stall": stall}, expected, enable)
                    print(json.dumps({"pair": i + 1, "arm": arm, "stall": stall, **row}), flush=True)


if __name__ == "__main__":
    if sys.argv[1:2] == ["--worker"]:
        worker(Path(sys.argv[2]))
    else:
        main()
