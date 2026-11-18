"""Bounded, machine-resident recovery for the trusted POSIX job endpoint.

This controls execution availability, never scientific acceptance. Commands and
replay authority come only from the pinned operator template, not job input.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import stat
import time

from research_job_checkpoints import resolve_bundle


_STALL_ERROR = "semantic progress deadline exceeded"


def _integer(value, low, high):
    return type(value) is int and low <= value <= high


def _argv(value):
    return (isinstance(value, list) and bool(value)
            and all(isinstance(x, str) and x and "\0" not in x for x in value)
            and Path(value[0]).is_absolute())


def _finite(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def _unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate progress key")
        value[key] = item
    return value


_MAX_RECORD_DEPTH = 16


def _bounded_depth(value):
    # Iterative JSON parsing (Python 3.14+) no longer raises RecursionError on
    # hostile nesting, so record depth must be rejected explicitly here.
    stack = [(value, 0)]
    while stack:
        node, depth = stack.pop()
        if depth >= _MAX_RECORD_DEPTH:
            return False
        if isinstance(node, dict):
            stack.extend((item, depth + 1) for item in node.values())
        elif isinstance(node, list):
            stack.extend((item, depth + 1) for item in node)
    return True


def validate_supervision(cfg):
    if "supervision" not in cfg:
        return
    s = cfg["supervision"]
    if (not isinstance(s, dict) or set(s) - {"replaySafe", "maxAttempts", "retryExitCodes", "backoffMs",
            "pollMs", "stallMs", "retryOnStall", "bootstrap", "checkpoint", "goal"}
            or s.get("replaySafe") is not True
            or not _integer(s.get("maxAttempts"), 1, 32)
            or not isinstance(s.get("retryExitCodes"), list)
            or (not s["retryExitCodes"] and s.get("retryOnStall") is not True) or len(s["retryExitCodes"]) > 32
            or any(not _integer(x, -64, 255) or x == 0 for x in s["retryExitCodes"])
            or not _integer(s.get("backoffMs"), 0, 600000)
            or not _integer(s.get("pollMs", 1000), 20, 60000)):
        raise ValueError("invalid bounded job supervision or replay authority")
    if "stallMs" in s and not _integer(s["stallMs"], 100, 604800000):
        raise ValueError("invalid semantic progress deadline")
    if "retryOnStall" in s and (type(s["retryOnStall"]) is not bool or
            (s["retryOnStall"] and ("stallMs" not in s or "checkpoint" not in s))):
        raise ValueError("stall recovery requires a pinned progress deadline and checkpoint contract")
    if "bootstrap" in s:
        b = s["bootstrap"]
        if (not isinstance(b, dict) or set(b) != {"argv", "timeoutMs"}
                or not _argv(b["argv"]) or not _integer(b["timeoutMs"], 100, 3600000)):
            raise ValueError("invalid pinned bootstrap")
    if "checkpoint" in s:
        c = s["checkpoint"]
        if (not isinstance(c, dict) or set(c) - {"root", "contract", "components", "maxBytes"}
                or not isinstance(c.get("root"), str) or not Path(c["root"]).is_absolute()
                or "\0" in c["root"] or not isinstance(c.get("contract"), str)
                or not re.fullmatch(r"[a-f0-9]{64}", c["contract"])
                or not isinstance(c.get("components"), list) or not 1 <= len(c["components"]) <= 32
                or any(not isinstance(x, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", x)
                       or x == "manifest.json" for x in c["components"])
                or len(set(c["components"])) != len(c["components"])
                or not _integer(c.get("maxBytes", 1024**4), 1, 1024**4)):
            raise ValueError("invalid complete checkpoint contract")
    if "goal" in s:
        g = s["goal"]
        if (not isinstance(g, dict) or set(g) - {"name", "contract", "direction", "baseline", "staleMs", "minDelta"}
                or not isinstance(g.get("name"), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", g["name"])
                or not isinstance(g.get("contract"), str) or not re.fullmatch(r"[a-f0-9]{64}", g["contract"])
                or g.get("direction") not in ("maximize", "minimize") or not _finite(g.get("baseline"))
                or not _finite(g.get("minDelta", 0)) or g.get("minDelta", 0) < 0
                or not _integer(g.get("staleMs"), 100, 604800000)):
            raise ValueError("invalid goal observation contract")


class Progress:
    """Execution milestones and reported goal measurements are different clocks."""
    def __init__(self, path, policy):
        self.path, self.policy = path, policy
        self.sequence = -1
        self.attempt_sequence = -1
        self.replay_through = -1
        self.advanced = time.monotonic()
        self.metric_sequence = -1
        self.metric_at = None
        self.metric = None
        self.invalid_metric = False
        self.best = policy.get("goal", {}).get("baseline")
        self.last_improvement = None

    def resume_from(self, fresh_path, step):
        # A fresh attempt file cannot inherit the failed attempt's last record.
        # Count catch-up above the saved step only for this worker's stall clock.
        self.path = fresh_path
        self.attempt_sequence = step
        self.replay_through = max(self.sequence, step)

    def observe(self):
        # Nonblocking bounded reads: a missing/partial/FIFO telemetry file cannot
        # freeze the keeper or manufacture a healthy milestone.
        try:
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as source:
                st = os.fstat(source.fileno())
                if not stat.S_ISREG(st.st_mode) or st.st_size > 65536:
                    return
                raw = source.read(65537)
            if len(raw) > 65536:
                return
            record = json.loads(raw, object_pairs_hook=_unique)
            if not _bounded_depth(record):
                return
            sequence = record.get("sequence")
        except (OSError, ValueError, AttributeError, RecursionError):
            return
        if not _integer(sequence, 0, 2**53 - 1):
            return
        if sequence > self.attempt_sequence:
            self.attempt_sequence = sequence
            self.sequence = max(self.sequence, sequence)
            self.advanced = time.monotonic()
        goal = self.policy.get("goal")
        if not goal or "metric" not in record or sequence <= self.replay_through:
            return
        metric = record["metric"]
        if (not isinstance(metric, dict) or set(metric) != {"name", "contract", "value", "samples"}
                or metric.get("name") != goal["name"] or metric.get("contract") != goal["contract"]
                or not _finite(metric.get("value")) or not _integer(metric.get("samples"), 1, 2**53 - 1)):
            self.invalid_metric = True
            return
        if (not _finite(metric["value"] - goal["baseline"])
                or not _finite(metric["value"] - self.best)):
            self.invalid_metric = True
            return
        # A repeated measurement cannot renew the job-wide goal clock.
        if sequence <= self.metric_sequence or sequence < self.sequence:
            return
        self.invalid_metric = False
        self.metric_sequence, self.metric_at, self.metric = sequence, time.monotonic(), metric
        delta = metric["value"] - self.best
        if goal["direction"] == "minimize":
            delta = -delta
        if delta > goal.get("minDelta", 0):
            self.best, self.last_improvement = metric["value"], sequence

    def goal(self):
        g = self.policy.get("goal")
        if not g:
            return None
        delta = (self.metric["value"] - g["baseline"]) if self.metric else None
        best_delta = self.best - g["baseline"]
        if g["direction"] == "minimize":
            delta = -delta if delta is not None else None
            best_delta = -best_delta
        status = ("UNMEASURED" if delta is None else "IMPROVED" if delta > g.get("minDelta", 0)
                  else "REGRESSED" if delta < -g.get("minDelta", 0) else "UNCHANGED")
        if self.metric_at is not None and (time.monotonic() - self.metric_at) * 1000 >= g["staleMs"]:
            status = "STALE"
        if self.invalid_metric:
            status = "INVALID"
        return {"name": g["name"], "contract": g["contract"], "direction": g["direction"],
                "baseline": g["baseline"], "value": self.metric["value"] if self.metric else None,
                "best": self.best, "delta": delta, "bestDelta": best_delta,
                "samples": self.metric["samples"] if self.metric else None,
                "measurementSequence": self.metric_sequence if self.metric else None,
                "lastImprovementSequence": self.last_improvement, "status": status,
                "trust": "OBSERVATION_NOT_ACCEPTANCE"}

    def stalled(self):
        limit = self.policy.get("stallMs")
        return bool(limit and (time.monotonic() - self.advanced) * 1000 >= limit)


def run_supervised(directory, cfg, execute, atomic, encoded):
    """Hold the caller's worker.lock across all attempts, bootstrap and backoff.

    execute() reaps/kills its owned process group before returning. No RPC,
    discovery regex, port or model request occurs in this loop.
    """
    policy = cfg["supervision"]
    # A shared template may serve different seeds/inputs. Never adopt another
    # logical job's state just because both use the same checkpoint format.
    checkpoint_root = Path(policy["checkpoint"]["root"]) / directory.name if "checkpoint" in policy else None
    started = time.monotonic()
    deadline = started + cfg["timeoutMs"] / 1000
    progress = Progress(directory / "progress.json", policy)
    history, previous_failure = [], None
    summary = {"attempts": 0, "restarts": 0, "maxAttempts": policy["maxAttempts"],
               "phase": "STARTING", "lastSequence": None, "history": history}
    previous_snapshot = None

    def snapshot(phase=None):
        nonlocal previous_snapshot
        progress.observe()
        if phase:
            summary["phase"] = phase
        summary["lastSequence"] = progress.sequence if progress.sequence >= 0 else None
        if "goal" in policy:
            summary["goal"] = progress.goal()
        raw = encoded(summary)
        if raw != previous_snapshot:
            atomic(directory / "supervision.json", summary)
            previous_snapshot = raw
        return _STALL_ERROR if progress.stalled() else None

    def checkpoint():
        c = policy.get("checkpoint")
        if not c:
            return None
        return resolve_bundle(checkpoint_root, c["contract"], c["components"],
                              max_bytes=c.get("maxBytes", 1024**4), deadline=deadline)

    def finish(result, evidence_attempt):
        success = result["exitCode"] == 0 and "error" not in result
        snapshot("SUCCEEDED" if success else "FAILED")
        result["supervision"] = summary
        result["durationMs"] = round((time.monotonic() - started) * 1000)
        result["configurationHash"] = hashlib.sha256(encoded(cfg)).hexdigest()
        return result, evidence_attempt

    result, evidence_attempt = {"exitCode": None}, None
    try:
        selection = checkpoint()
    except TimeoutError:
        return finish({"exitCode": None, "error": "trusted job deadline exceeded validating checkpoint"}, None)
    except (OSError, ValueError):
        return finish({"exitCode": None, "error": "checkpoint inventory unreadable; reconcile before launch"}, None)
    for attempt in range(1, policy["maxAttempts"] + 1):
        if time.monotonic() >= deadline:
            result["error"] = "trusted job deadline exceeded across all attempts"
            break
        attempt_dir = directory / "attempts" / str(attempt)
        attempt_dir.mkdir(parents=True, mode=0o700)
        if attempt > 1 and selection and policy.get("retryOnStall"):
            progress.resume_from(attempt_dir / "progress.json", selection["step"])
        env = {"FUTURE_JOB_KEY": directory.name, "FUTURE_JOB_ATTEMPT": str(attempt),
               "FUTURE_JOB_INPUT_PATH": str(directory / "input.json"),
               "FUTURE_JOB_PROGRESS_PATH": str(progress.path)}
        if "checkpoint" in policy:
            c = policy["checkpoint"]
            env.update(FUTURE_JOB_CHECKPOINT_ROOT=str(checkpoint_root), FUTURE_JOB_CHECKPOINT_CONTRACT=c["contract"])
        if selection:
            env.update(FUTURE_JOB_RESUME_PATH=selection["path"], FUTURE_JOB_RESUME_STEP=str(selection["step"]))
        if "bootstrap" in policy:
            snapshot("BOOTSTRAP")
            boot_dir = attempt_dir / "bootstrap"
            boot_dir.mkdir(mode=0o700)
            bootstrap = policy["bootstrap"]
            boot_cfg = {"argv": bootstrap["argv"], "envAllow": cfg.get("envAllow", []),
                        **({"cwd": cfg["cwd"]} if "cwd" in cfg else {})}
            boot = execute(boot_dir, boot_cfg, env, min(deadline, time.monotonic() + bootstrap["timeoutMs"] / 1000), None)
            atomic(boot_dir / "receipt.json", boot)
            if boot["exitCode"] != 0 or "error" in boot:
                result = {"exitCode": None, "error": "pinned bootstrap failed; job not launched", "bootstrap": boot}
                break
        if time.monotonic() >= deadline:
            result["error"] = "trusted job deadline exceeded during bootstrap"
            break
        summary["attempts"], summary["restarts"] = attempt, attempt - 1
        # Each attempt gets a boot grace period; older milestones are retained
        # so replaying step N does not renew the progress clock indefinitely.
        progress.advanced = time.monotonic()
        snapshot("RUNNING")
        result = execute(attempt_dir, cfg, env, deadline, snapshot)
        evidence_attempt = attempt
        snapshot()
        atomic(attempt_dir / "receipt.json", result)
        history.append({"attempt": attempt, "exitCode": result["exitCode"],
                        "resumeStep": selection["step"] if selection else None,
                        "durationMs": result["durationMs"],
                        "receiptSha256": hashlib.sha256(encoded(result)).hexdigest()})
        # A watchdog kill is deliberately distinct from an application exit.
        # Only the host's isolated stall diagnosis, after its owned child was
        # killed and reaped, can use this checkpoint-only recovery authority.
        retry_stall = (policy.get("retryOnStall") is True and result.get("error") == _STALL_ERROR
                       and result["exitCode"] == -signal.SIGKILL)
        if result["exitCode"] == 0 or ("error" in result and not retry_stall):
            break
        if attempt >= policy["maxAttempts"] or (not retry_stall and result["exitCode"] not in policy["retryExitCodes"]):
            result.setdefault("error", "process failed; retry class or attempt budget does not permit recovery")
            break
        try:
            selection = checkpoint()
        except TimeoutError:
            result["error"] = "trusted job deadline exceeded validating checkpoint"
            break
        except (OSError, ValueError):
            result["error"] = "checkpoint inventory unreadable; reconcile before recovery"
            break
        if "checkpoint" in policy and selection is None:
            result["error"] = "no complete matching checkpoint; cold restart is not authorized"
            break
        failure = (result["exitCode"], selection["step"] if selection else None)
        if failure == previous_failure:
            result["error"] = "unchanged failure after one retry; diagnose before further execution"
            break
        previous_failure = failure
        snapshot("BACKOFF")
        time.sleep(max(0, min(policy["backoffMs"] / 1000, deadline - time.monotonic())))
        if time.monotonic() >= deadline:
            result["error"] = "trusted job deadline exceeded during recovery backoff"
            break
    return finish(result, evidence_attempt)
