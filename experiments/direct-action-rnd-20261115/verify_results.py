#!/usr/bin/env python3
"""Independent recomputation of the live component canary's raw evidence.

Does not import the producer harness or its scoring/aggregation helpers.
Actual final PASS artifacts are rechecked by the frozen independent checker.
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
from pathlib import Path
import shutil
import statistics
import subprocess
import sys
import tempfile


HERE = Path(__file__).resolve().parent
TERMINAL = {"PASS", "FAIL", "TIMEOUT"}


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def load(path: Path):
    return json.loads(path.read_bytes())


def check(condition, message, errors):
    if not condition:
        errors.append(message)


def receipt_content(result):
    if "text" in result:
        return result["text"]
    return json.dumps({key: result[key] for key in ("code", "stdout", "stderr") if key in result}, sort_keys=True)


def action_identity(action):
    tool = action["tool"]
    args = {key: value for key, value in action.items() if key != "tool"}
    if tool == "Read":
        args = {"file_path": action["path"]}
    elif tool in {"Edit", "Write"}:
        args = {"file_path": action["path"], **{key: value for key, value in args.items() if key != "path"}}
    return tool, args


def audit_trial(folder: Path, manifest: dict, contract: dict, sources: Path, replay=False, recheck=False):
    errors = []
    state = load(folder / "state.json")
    meta = load(folder / "meta.json")
    ident = state["id"]
    frozen = manifest[ident]
    check((state["kind"], state["arm"], state["repetition"]) ==
          (frozen["kind"], frozen["arm"], frozen["repetition"]), "trial identity mismatch", errors)
    check(state["status"] in TERMINAL, "trial not terminal", errors)
    events, requests, history = state["events"], state["requests"], state["history"]
    seed = state["seed_events"]
    check(seed == frozen["seed_events"], "seed event count mismatch", errors)
    check(len(events) - seed == state["tool_actions"], "tool-action counter differs from raw events", errors)
    check(len(requests) == state["model_decisions"], "decision counter differs from requests", errors)
    check(0 <= len(requests) <= contract["budgets"]["model_decisions_per_trial"], "decision budget mismatch", errors)
    normalized = json.dumps(history[:2 * seed + 1], sort_keys=True).replace(state["workspace"], "$WORKSPACE")
    check(digest(normalized.encode()) == frozen["normalized_seed_history_sha256"], "seed history hash mismatch", errors)
    for name, expected in frozen["initial_file_sha256"].items():
        if name == "config.json" and state["kind"] in {"extension_seeded", "recovery_seeded"}:
            config = {"task_file": "data/train-v1.json", "engine": "python" if state["kind"] == "extension_seeded" else "accelerator"}
            actual = digest((json.dumps(config, indent=2) + "\n").encode())
        else:
            actual = digest((Path(state["workspace"]) / name).read_bytes())
        check(actual == expected, "frozen initial/source input mismatch: " + name, errors)
    for name, expected in meta["protected_sha256"].items():
        check(frozen["initial_file_sha256"].get(name) == expected, "protected manifest differs from frozen inputs: " + name, errors)
    goal = load(Path(state["workspace"]) / ".future-code/goal-autonomy.json")
    check(goal["maxContinuations"] == 6 and goal["totalContinuations"] <= 6,
          "host continuation budget changed", errors)

    # Every actual tool receipt must remain paired, ordered and identical to
    # its raw event. Meta acceptance notices are not productive tool receipts.
    pairs = []
    for index, message in enumerate(history):
        blocks = message.get("message", {}).get("content")
        if message.get("type") != "assistant" or not isinstance(blocks, list):
            continue
        for call in blocks:
            if call.get("type") != "tool_use":
                continue
            result_message = history[index + 1] if index + 1 < len(history) else {}
            results = result_message.get("message", {}).get("content", [])
            match = [item for item in results if isinstance(item, dict) and item.get("type") == "tool_result"
                     and item.get("tool_use_id") == call["id"]] if isinstance(results, list) else []
            check(len(match) == 1, "missing/ambiguous tool receipt", errors)
            if len(match) == 1:
                pairs.append((call, match[0]))
    check(len(pairs) == len(events), "event/history receipt count mismatch", errors)
    for index, (event, pair) in enumerate(zip(events, pairs)):
        call, result = pair
        check(call.get("id") == f"c{index}" and call["name"] == event["tool"] and call["input"] == event["input"],
              "event/call identity mismatch", errors)
        check(result["content"] == receipt_content(event["result"]) and
              result.get("is_error", False) == (event["result"]["code"] != 0), "event/receipt payload mismatch", errors)
        check(type(event["result"].get("elapsed_ns")) is int and event["result"]["elapsed_ns"] >= 0,
              "invalid tool elapsed time", errors)
        if index:
            check(event["at_ns"] >= events[index - 1]["at_ns"], "nonmonotonic receipt timestamps", errors)

    selected = []
    acceptance_count = 0
    response_files = []
    wall = state.get("observed_wall_ns", 0)
    latency = 0
    timeout_requests = 0
    warnings = 0
    replayed = 0
    for index, record in enumerate(requests, 1):
        check(record["sequence"] == index, "request sequence mismatch", errors)
        request = load(folder / f"request-{index}.json")
        packet = request["packet"]
        check(record["ready_ns"] == request["ready_ns"], "request-ready timestamp mismatch", errors)
        check(digest(json.dumps(packet, sort_keys=True).encode()) == record["request_sha256"], "request packet hash mismatch", errors)
        messages = packet["production_messages"]
        check(digest(json.dumps(messages, ensure_ascii=False).encode()) == request["view_sha256"], "production view hash mismatch", errors)
        check(packet["task"] == state["instruction"] and packet["decision"] == index and packet["max_decisions"] == 6,
              "model-visible task/budget mismatch", errors)
        check(packet["readable_files"] == state["readable"] and packet["writable_files"] == state["writable"]
              and packet["allowed_commands"] == state["commands"], "model-visible tool permissions mismatch", errors)
        prefix = messages[1:-1]
        expected_prefix = json.loads(json.dumps(history[:len(prefix)], ensure_ascii=False).replace(state["workspace"], "$WORKSPACE"))
        check(prefix == expected_prefix, "request history differs from preserved receipt prefix", errors)
        warnings += "Host Action Review" in json.dumps(messages[-1])
        if replay:
            code = """import {pathToFileURL} from 'node:url';
const p=JSON.parse((await import('node:fs')).readFileSync(0,'utf8'));
const c=await import(pathToFileURL(p.source+'/src/commands/goal/context.ts'));
console.log(JSON.stringify(c.appendGoalRequestAnchor(p.history,{cwd:p.workspace,mainThread:true,
makeMessage:content=>({type:'user',isMeta:true,message:{content}}),executionPolicy:c.goalExecutionPolicy(true,p.workspace)})));
"""
            result = subprocess.run(["node", "--experimental-strip-types", "--input-type=module", "-e", code],
                input=json.dumps({"source": str(sources / state["arm"]), "workspace": state["workspace"],
                                 "history": history[:len(prefix)]}), text=True, capture_output=True, timeout=10)
            check(result.returncode == 0, "production projection replay failed", errors)
            if result.returncode == 0:
                actual = json.loads(json.dumps(json.loads(result.stdout), ensure_ascii=False).replace(state["workspace"], "$WORKSPACE"))
                check(actual == messages, "actual production projection differs from delivered view", errors)
                replayed += 1
        response_path = folder / f"response-{index}.json"
        raw = response_path.read_bytes()
        response_files.append(response_path.name)
        check(digest(raw) == record["response_sha256"], "response bytes/hash mismatch", errors)
        actual_latency = record["response_written_ns"] - record["ready_ns"]
        check(actual_latency >= 0 and actual_latency == record["response_latency_ns"], "response latency arithmetic mismatch", errors)
        latency += actual_latency
        if actual_latency > contract["budgets"]["response_deadline_seconds"] * 1_000_000_000:
            timeout_requests += 1
            check(state["status"] == "TIMEOUT" and index == len(requests), "late response did not retain terminal TIMEOUT", errors)
            continue
        try:
            reply = json.loads(raw)
            actions = reply["actions"]
            if not isinstance(actions, list) or not 1 <= len(actions) <= 4 or len(raw) > 16000:
                continue  # Producer retains malformed responses as protocol failures.
            for action in actions:
                if action["tool"] == "Finish":
                    acceptance_count += 1
                    attempts = state.get("acceptance_attempts", [])
                    if acceptance_count <= len(attempts) and attempts[acceptance_count - 1]["code"] == 0:
                        check(action.get("answer") == state["answer"], "accepted answer differs from selected Finish", errors)
                        break
                else:
                    selected.append(action_identity(action))
        except (KeyError, TypeError, ValueError):
            continue
    check(len(selected) == len(events) - seed, "selected/executed action count mismatch", errors)
    for selected_action, event in zip(selected, events[seed:]):
        check(selected_action == (event["tool"], event["input"]), "executed action differs from raw responder selection", errors)
    check(acceptance_count == len(state.get("acceptance_attempts", [])), "Finish/acceptance attempt count mismatch", errors)
    check({p.name for p in folder.glob("response-*.json")} == set(response_files), "untracked/unconsumed raw response file", errors)
    check(wall == state["finished_ns"] - state["started_ns"] and wall >= 0,
          "wall-time arithmetic mismatch", errors)
    tools_ns = sum(event["result"]["elapsed_ns"] for event in events[seed:])
    checks_ns = sum(item["elapsed_ns"] for item in state.get("acceptance_attempts", []))
    unassigned = wall - latency - tools_ns - checks_ns
    check(unassigned >= 0, "overlapping or impossible component timing", errors)
    final_check = None
    if state["status"] == "PASS":
        attempts = state.get("acceptance_attempts", [])
        check(bool(attempts) and attempts[-1]["code"] == 0 and json.loads(attempts[-1]["stdout"]).get("accepted") is True,
              "PASS lacks independently accepted receipt", errors)
        check(load(folder / "answer.json") == state["answer"], "final answer artifact mismatch", errors)
        if recheck and not errors:
            result = subprocess.run([sys.executable, "-I", "-B", str(HERE / "checker.py"),
                "--kind", state["kind"], "--workspace", state["workspace"], "--meta", str(folder / "meta.json"),
                "--answer", str(folder / "answer.json")], text=True, capture_output=True, timeout=20)
            final_check = {"code": result.returncode, "stdout": result.stdout, "stderr": result.stderr}
            check(result.returncode == 0 and json.loads(result.stdout).get("accepted") is True,
                  "fresh final artifact acceptance failed", errors)
    push_diagnostic = None
    if state["kind"] == "push_clean":
        pushes = [event for event in events[seed:] if event["tool"] == "Bash"
                  and event["input"].get("command") == "git push origin HEAD:refs/heads/result"
                  and event["result"]["code"] == 0]
        remote = subprocess.run(["git", "--git-dir", meta["remote_path"], "rev-parse", "refs/heads/result"],
            text=True, capture_output=True, timeout=10)
        delivered = remote.returncode == 0 and remote.stdout.strip() == meta["expected_commit"]
        check(delivered == bool(pushes), "push event and final remote effect disagree", errors)
        delivery_check = final_check
        if delivered and recheck and not errors and delivery_check is None:
            # A late Finish was deliberately never executed, so a TIMEOUT may
            # have no answer file. Use an analysis-only null answer outside
            # measured directories; push acceptance does not use its value.
            with tempfile.TemporaryDirectory(prefix="independent-push-answer-") as temporary:
                answer = Path(temporary) / "answer.json"
                answer.write_text("null\n")
                result = subprocess.run([sys.executable, "-I", "-B", str(HERE / "checker.py"),
                    "--kind", state["kind"], "--workspace", state["workspace"], "--meta", str(folder / "meta.json"),
                    "--answer", str(answer)], text=True, capture_output=True, timeout=20)
                delivery_check = {"code": result.returncode, "stdout": result.stdout, "stderr": result.stderr}
                check(result.returncode == 0 and json.loads(result.stdout).get("accepted") is True,
                      "fresh delivered Git effect verification failed", errors)
        push_diagnostic = {"scope": "POST_HOC_DIAGNOSTIC_NOT_FROZEN_PRIMARY_OR_PROMOTION_METRIC",
            "first_successful_push_return_bound_ns": pushes[0]["at_ns"] - state["started_ns"] if pushes else None,
            "first_successful_push_tool_elapsed_ns": pushes[0]["result"]["elapsed_ns"] if pushes else None,
            "final_remote_ref_matches": delivered, "fresh_delivery_check": delivery_check,
            "primary_trial_status_unchanged": state["status"],
            "limitation": "A successful synchronous push has returned by the receipt timestamp; no precise remote-server update timestamp is inferred. A delivered timeout remains a primary TIMEOUT."}
    return {"id": ident, "kind": state["kind"], "repetition": state["repetition"], "arm": state["arm"],
            "status": state["status"], "model_decisions": len(requests), "tool_actions": len(events) - seed,
            "seed_events": seed, "acceptance_checks": len(state.get("acceptance_attempts", [])),
            "observed_wall_ns": wall, "request_ready_to_response_ns": latency, "tool_ns": tools_ns,
            "acceptance_ns": checks_ns, "unassigned_controller_projection_ns": unassigned,
            "late_responses": timeout_requests, "action_review_views": warnings,
            "production_views_replayed": replayed, "fresh_final_check": final_check,
            "git_push_diagnostic": push_diagnostic, "errors": errors}


def aggregate(rows):
    output = {}
    for stratum, chosen in (("all", rows), ("clean_start", [r for r in rows if r["kind"].endswith("clean")]),
                             ("seeded_recovery", [r for r in rows if r["kind"].endswith("seeded")])):
        output[stratum] = {}
        for arm in ("base", "candidate"):
            group = [r for r in chosen if r["arm"] == arm]
            output[stratum][arm] = {"trials": len(group), "statuses": dict(collections.Counter(r["status"] for r in group)),
                "accepted": sum(r["status"] == "PASS" for r in group),
                **{key: sum(r[key] for r in group) for key in ("model_decisions", "tool_actions", "acceptance_checks",
                    "observed_wall_ns", "request_ready_to_response_ns", "tool_ns", "acceptance_ns", "unassigned_controller_projection_ns")}}
    pairs = []
    for kind, repetition in sorted({(r["kind"], r["repetition"]) for r in rows}):
        a = next(r for r in rows if (r["kind"], r["repetition"], r["arm"]) == (kind, repetition, "base"))
        b = next(r for r in rows if (r["kind"], r["repetition"], r["arm"]) == (kind, repetition, "candidate"))
        pairs.append({"kind": kind, "repetition": repetition, "base_status": a["status"], "candidate_status": b["status"],
                      "candidate_minus_base_decisions": b["model_decisions"] - a["model_decisions"],
                      "candidate_over_base_wall_ratio": b["observed_wall_ns"] / a["observed_wall_ns"]})
    seeded = output["seeded_recovery"]
    reduction = 1 - seeded["candidate"]["model_decisions"] / seeded["base"]["model_decisions"]
    output["paired"] = pairs
    output["frozen_rule_numeric_only"] = {
        "no_observed_acceptance_degradation": output["all"]["candidate"]["accepted"] >= output["all"]["base"]["accepted"],
        "seeded_decision_reduction": reduction,
        "median_all_pair_wall_ratio": statistics.median(p["candidate_over_base_wall_ratio"] for p in pairs),
        "median_seeded_pair_wall_ratio": statistics.median(p["candidate_over_base_wall_ratio"] for p in pairs if p["kind"].endswith("seeded")),
        "causal_speedup_established": False,
        "reason": "Ratios include all failures but cannot remove coordinator/provider timing contamination or establish general productivity."}
    rule = output["frozen_rule_numeric_only"]
    rule["exploratory_numeric_threshold_met"] = rule["no_observed_acceptance_degradation"] and reduction >= .2 and rule["median_all_pair_wall_ratio"] <= .8
    return output


def delivery_audit(path: Path):
    report = load(path)
    rows = []
    for row in report["rows"]:
        rep, arm = row["repetition"], row["arm"]
        root = Path(report["root"])
        workspace, remote = root / f"{rep}-{arm}", root / f"{rep}-{arm}.git"
        result = subprocess.run(["git", "--git-dir", str(remote), "rev-parse", "refs/heads/result"], text=True, capture_output=True, timeout=10)
        delivered = result.returncode == 0 and result.stdout.strip() == row["expectedCommit"]
        errors = []
        check(delivered == row["delivered"] == row["independentAccepted"], "host delivery/ref mismatch", errors)
        check(digest((workspace / "artifact.py").read_bytes()) == row["artifactSha256"], "host artifact hash mismatch", errors)
        goal = load(workspace / ".future-code/goal-autonomy.json")
        check(goal["maxContinuations"] == 6 and goal["state"] == row["goalState"] and
              goal["continuations"] == row["continuations"], "host retained goal budget/state mismatch", errors)
        with tempfile.TemporaryDirectory(prefix="independent-delivery-check-") as temporary:
            if delivered:
                clone = Path(temporary) / "clone"
                subprocess.run(["git", "clone", "--quiet", "--branch", "result", str(remote), str(clone)], check=True, capture_output=True, timeout=10)
                check(digest((clone / "artifact.py").read_bytes()) == row["artifactSha256"], "fresh delivered byte hash mismatch", errors)
                run = subprocess.run([sys.executable, "-I", "-B", str(clone / "artifact.py")], text=True, capture_output=True, timeout=5)
                check(run.returncode == 0 and run.stdout.strip() == "PASS", "fresh independent delivered self-check failed", errors)
                code = """import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('delivered',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
print(json.dumps([module.transform(value) for value in (-11,4,16)]))
"""
                result = subprocess.run([sys.executable, "-I", "-B", "-c", code, str(clone / "artifact.py")],
                    text=True, capture_output=True, timeout=5)
                check(result.returncode == 0 and json.loads(result.stdout) == [3 * value + 7 + rep for value in (-11, 4, 16)],
                      "fresh delivered artifact differs from independent arithmetic specification", errors)
        rows.append({"arm": arm, "repetition": rep, "delivered": delivered, "errors": errors})
    return {"kind": report["kind"], "live_model_calls": report["liveModelCalls"], "rows": rows,
            "base_delivered": sum(r["delivered"] for r in rows if r["arm"] == "base"),
            "candidate_delivered": sum(r["delivered"] for r in rows if r["arm"] == "candidate"),
            "limitation": "Deterministic recovered delivery, not a live speedup experiment."}


def verify(lab, contract_path, manifest_path, replay=True, recheck=True):
    contract, manifest = load(contract_path), load(manifest_path)
    errors = []
    check(digest(manifest_path.read_bytes()) == contract["task_manifest_sha256"], "task manifest hash mismatch", errors)
    check(load(lab / "order.json") == contract["order"] and set(contract["order"]) == set(manifest), "trial order/coverage mismatch", errors)
    check(len(manifest) == contract["trials"] == 24, "all-trial denominator mismatch", errors)
    for name, expected in contract["measurement_files_sha256"].items():
        check(digest((HERE / name).read_bytes()) == expected, "frozen measurement source changed: " + name, errors)
    for arm, files in contract["source_sha256"].items():
        for name, expected in files.items():
            check(digest((lab / "sources" / arm / name).read_bytes()) == expected, "frozen source changed: " + arm + "/" + name, errors)
    for kind in contract["cases"]:
        for rep in range(contract["repetitions"]):
            pair = [v for v in manifest.values() if v["kind"] == kind and v["repetition"] == rep]
            check(len(pair) == 2 and {r["arm"] for r in pair} == {"base", "candidate"}, "incomplete matched pair", errors)
            if len(pair) == 2:
                check(pair[0]["initial_file_sha256"] == pair[1]["initial_file_sha256"] and
                      pair[0]["normalized_seed_history_sha256"] == pair[1]["normalized_seed_history_sha256"], "unmatched starting state", errors)
    rows = []
    raw_hashes = {}
    for ident in contract["order"]:
        folder = lab / "trials" / ident
        state = load(folder / "state.json")
        if state["status"] not in TERMINAL:
            raise RuntimeError("PENDING: " + ident + " is " + state["status"])
        rows.append(audit_trial(folder, manifest, contract, lab / "sources", replay=replay, recheck=recheck))
        for path in folder.glob("*.json"):
            raw_hashes[str(path.relative_to(lab))] = digest(path.read_bytes())
    report = {"schema": 1, "kind": "INDEPENDENT_COMPONENT_CANARY_RECOMPUTATION", "experiment_id": contract["experiment_id"],
              "verifier_sha256": digest(Path(__file__).read_bytes()),
              "contract_sha256": digest(contract_path.read_bytes()), "task_manifest_sha256": digest(manifest_path.read_bytes()),
              "audit_status": "PASS" if not errors and not any(r["errors"] for r in rows) else "FAIL",
              "errors": errors, "trials": rows, "summary": aggregate(rows), "raw_file_sha256": raw_hashes,
              "speedup_verdict": "NO_GENERAL_SPEEDUP_ESTABLISHED",
              "timing_limitation": "Request-ready latency includes dispatch. Remaining wall-time gaps include coordinator/projection work. Provider and controller contributions are not separately authenticated in the frozen schema.",
              "provider_tokens": None, "exact_backend_revision": None, "nested_tool_trace_audited": False}
    transport = lab / "transport.jsonl"
    if transport.exists():
        records = [json.loads(line) for line in transport.read_text().splitlines() if line.strip()]
        indexed = {(item["id"], item["sequence"]): item for item in records}
        transport_errors = []
        check(len(indexed) == len(records), "duplicate transport records", transport_errors)
        check(len(records) == sum(row["model_decisions"] for row in rows), "transport/request count mismatch", transport_errors)
        intervals = []
        for row in rows:
            state = load(lab / "trials" / row["id"] / "state.json")
            for request in state["requests"]:
                event = indexed.get((row["id"], request["sequence"]))
                check(event is not None, "missing dispatch record", transport_errors)
                if event is not None:
                    check(event["ready_ns"] == request["ready_ns"] and event["post_spawn_ns"] >= event["ready_ns"],
                          "dispatch timestamp mismatch", transport_errors)
                    intervals.append(event["post_spawn_ns"] - event["ready_ns"])
        report["dispatch_evidence"] = {"sha256": digest(transport.read_bytes()), "records": len(records),
            "median_ready_to_spawn_ack_ns": statistics.median(intervals) if intervals else None,
            "max_ready_to_spawn_ack_ns": max(intervals) if intervals else None, "errors": transport_errors,
            "limitation": "Post-spawn acknowledgement bounds dispatch bookkeeping; it does not authenticate provider inference-start time or tokens."}
        if transport_errors:
            report["audit_status"] = "FAIL"
    if (HERE / "delivery-recovery-results.json").exists():
        report["deterministic_delivery"] = delivery_audit(HERE / "delivery-recovery-results.json")
        if any(row["errors"] for row in report["deterministic_delivery"]["rows"]):
            report["audit_status"] = "FAIL"
    # Fresh altered copies must fail integrity checks without modifying the
    # original measured artifacts or relying on a producer's aggregation.
    template = lab / "trials" / contract["order"][0]
    tests = []
    for mutation in ("event_payload", "raw_response", "stored_request_hash"):
        with tempfile.TemporaryDirectory(prefix="rnd-tamper-") as temporary:
            copy = Path(temporary)
            for path in template.glob("*.json"):
                shutil.copy2(path, copy / path.name)
            state = load(copy / "state.json")
            if mutation == "event_payload":
                state["events"][0]["result"]["text"] = "altered evidence"
                (copy / "state.json").write_text(json.dumps(state))
            elif mutation == "raw_response":
                path = copy / "response-1.json"
                path.write_bytes(path.read_bytes() + b" ")
            else:
                state["requests"][0]["request_sha256"] = "0" * 64
                (copy / "state.json").write_text(json.dumps(state))
            tampered = audit_trial(copy, manifest, contract, lab / "sources")
            tests.append({"mutation": mutation, "detected": bool(tampered["errors"]), "errors": tampered["errors"]})
    report["tamper_controls"] = tests
    if not all(test["detected"] for test in tests):
        report["audit_status"] = "FAIL"
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--lab", type=Path, default=Path("/tmp/future-code-live-canary-20261115"))
    parser.add_argument("--contract", type=Path, default=HERE / "contract.json")
    parser.add_argument("--manifest", type=Path, default=HERE / "task-manifest.json")
    parser.add_argument("--output", type=Path, default=HERE / "independent-results.json")
    args = parser.parse_args()
    report = verify(args.lab, args.contract, args.manifest)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"audit_status": report["audit_status"], "summary": report["summary"], "output": str(args.output)}))
    return 0 if report["audit_status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
