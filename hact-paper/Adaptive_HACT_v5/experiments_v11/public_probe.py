"""Read-only recorder for the frozen public-library execution cohort.

No test order, selection, assertion or outcome is changed. A bounded profile
records the first 32 production calls as an execution-origin check; it is not
an execution-speed instrumentation contract.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sys
import time

import pytest


START = time.perf_counter()
ROOT = Path(os.environ.get("HACT_V11_SOURCE_ROOT", ".")).resolve()
STATE = {"schema": "hact-v11-public-checks-1", "registry": [], "executed": [],
         "records": {}, "collection_errors": [], "collection_skips": [],
         "production_calls_observed": [], "package_origins": {}}
OLD_PROFILE = None


def _save():
    output = os.environ.get("HACT_V11_PROBE_OUTPUT")
    if output:
        p = Path(output)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(STATE, indent=2, sort_keys=True) + "\n")
        os.replace(tmp, p)


def status_from_phases(phases):
    if any(p["outcome"] == "failed" for p in phases.values()):
        return "FAIL"
    if (set(phases) == {"setup", "call", "teardown"}
            and all(p["outcome"] == "passed" and not p.get("wasxfail")
                    for p in phases.values())):
        return "PASS"
    return "UNKNOWN"


def _profile(frame, event, arg):
    if event != "call":
        return
    filename = frame.f_code.co_filename
    if not filename.startswith(str(ROOT / "src") + os.sep):
        return
    path = Path(filename)
    if path.is_file():
        rel = path.relative_to(ROOT).as_posix()
        STATE["production_calls_observed"].append({
            "path": rel, "function": frame.f_code.co_name,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        if len(STATE["production_calls_observed"]) >= 32:
            sys.setprofile(OLD_PROFILE)


def pytest_sessionstart(session):
    global OLD_PROFILE
    OLD_PROFILE = sys.getprofile()
    sys.setprofile(_profile)


def pytest_collection_modifyitems(session, config, items):
    ids = [item.nodeid for item in items]
    if len(ids) != len(set(ids)):
        raise pytest.UsageError("duplicate public evidence identity")
    STATE["registry"] = ids
    STATE["scheduled"] = list(ids)
    STATE["session_finished"] = False
    _save()


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_protocol(item, nextitem):
    started = time.perf_counter()
    STATE["records"][item.nodeid] = {"phases": {}, "wall_seconds": None}
    try:
        yield
    finally:
        rec = STATE["records"][item.nodeid]
        rec["wall_seconds"] = time.perf_counter() - started


def pytest_runtest_logreport(report):
    rec = STATE["records"].setdefault(report.nodeid, {"phases": {}})
    phase = {"outcome": report.outcome, "seconds": report.duration}
    if hasattr(report, "wasxfail"):
        phase["wasxfail"] = str(report.wasxfail)
    rec["phases"][report.when] = phase
    if report.failed:
        rec["failure"] = str(report.longrepr)[:12000]
    if report.when == "teardown":
        if report.nodeid in STATE["executed"]:
            raise RuntimeError("duplicate final report")
        STATE["executed"].append(report.nodeid)
        rec["completed_at_seconds"] = time.perf_counter() - START
        rec["status"] = status_from_phases(rec["phases"])


def pytest_collectreport(report):
    if report.failed:
        STATE["collection_errors"].append(str(report.longrepr)[:12000])
    elif report.skipped:
        STATE["collection_skips"].append(str(report.longrepr)[:12000])


def pytest_sessionfinish(session, exitstatus):
    sys.setprofile(OLD_PROFILE)
    STATE["exitstatus"] = int(exitstatus)
    STATE["pytest_wall_seconds"] = time.perf_counter() - START
    STATE["python"] = sys.version
    STATE["pytest_version"] = pytest.__version__
    STATE["session_finished"] = True
    for rec in STATE["records"].values():
        rec["status"] = status_from_phases(rec["phases"])
    modules = os.environ.get("HACT_V11_TARGET_MODULES", "").split(",")
    for name in filter(None, modules):
        origin = getattr(sys.modules.get(name), "__file__", None)
        entry = {"path": origin}
        if origin and Path(origin).is_file():
            entry["sha256"] = hashlib.sha256(Path(origin).read_bytes()).hexdigest()
            entry["inside_source_root"] = Path(origin).resolve().is_relative_to(ROOT)
        STATE["package_origins"][name] = entry
    _save()
