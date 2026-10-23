"""Frozen-layout, actual-process controlled dispatch-shift campaign."""
from __future__ import annotations

import argparse
from collections import Counter
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time

from experiments_v11.public_collect import canonical, sha, stamp, validate_evidence, write_json
from experiments_v11.public_compiler_study import packet_bytes_reference
from experiments_v12.schedule_probe import schedule_ids

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "results/v12/schedule_shift"
PROJECTS = ("click", "jinja", "pluggy", "attrs", "exceptiongroup")
POLICIES = ("files", "items")
SEEDS = (2026102101, 2026102102, 2026102103)
LAYOUTS = {"original": "layout_original_compact.json",
           "historical": "historical_layout.json",
           "cap32": "selected_layout.json", "cap64": "selected_layout_sensitivity.json"}


def read(path):
    return json.loads(path.read_text())


def environment():
    distributions = sorted((d.metadata.get("Name", ""), d.version,
                            str(d.locate_file("")), str(getattr(d, "_path", "")))
                           for d in importlib.metadata.distributions())
    return {"python": sys.version, "executable": sys.executable,
            "platform": platform.platform(), "packages_with_locations": distributions}


def verify_sources(entry, source):
    for rel, digest in entry["source_file_sha256"].items():
        if not (source / rel).is_file() or sha((source / rel).read_bytes()) != digest:
            raise ValueError(f"source changed: {entry['project']}/{rel}")
    head = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"]).decode().strip()
    if head != entry["commit"]:
        raise ValueError("source commit changed")
    dirty = subprocess.check_output(["git", "-C", str(source), "status", "--porcelain"])
    if dirty:
        raise ValueError("tracked or nonignored untracked source changes")


def freeze(upstreams):
    target = OUT / "FROZEN_MANIFEST.json"
    if target.exists():
        raise FileExistsError("campaign already frozen; never overwrite or relaunch")
    parent = read(ROOT / "results/v11/public_checks/FROZEN_MANIFEST.json")
    entries = [e for e in parent["projects"] if e["project"] in PROJECTS]
    files = ["docs/V12_SCHEDULE_SHIFT_PROTOCOL.md",
             "experiments_v12/schedule_study.py", "experiments_v12/schedule_probe.py",
             "experiments_v11/public_probe.py", "experiments_v11/public_collect.py",
             "experiments_v11/public_compiler_study.py"]
    for entry in entries:
        verify_sources(entry, upstreams / entry["project"])
        base = f"results/v11/public_compiler/{entry['project']}/"
        files += [base + filename for filename in LAYOUTS.values()]
    value = {"schema": "hact-v12-schedule-shift-1", "frozen_at": stamp(),
             "projects": entries, "policies": list(POLICIES), "seeds": list(SEEDS),
             "files_sha256": {name: sha((ROOT / name).read_bytes()) for name in files},
             "environment": environment(), "wave_width": 8,
             "layout_roles": LAYOUTS, "source_root": str(upstreams),
             "excluded_project": {"project": "packaging", "status": "UNKNOWN",
                                  "reason": "unchanged v11 dense fitting budget"}}
    write_json(target, value)
    return value


def check_run(evidence, receipt, entry, source, policy, seed, registry):
    summary = validate_evidence(evidence)
    if not evidence.get("session_finished") or receipt.get("timeout"):
        raise ValueError("incomplete or timed-out session")
    if receipt["returncode"] not in (0, 1) or evidence.get("collection_errors"):
        raise ValueError("collection/startup/process failure")
    if sorted(evidence["registry"]) != sorted(registry):
        raise ValueError("acceptance registry changed")
    intervention = evidence["schedule_intervention"]
    if intervention["policy"] != policy or intervention["seed"] != seed:
        raise ValueError("wrong dispatch intervention")
    expected = schedule_ids(intervention["original_collection"], policy, seed)
    if evidence["scheduled"] != expected or evidence["executed"] != expected:
        raise ValueError("actual execution does not match recorded schedule")
    if not evidence["production_calls_observed"]:
        raise ValueError("missing production execution provenance")
    origins = evidence["package_origins"]
    if set(origins) != set(entry["target_modules"]) or not all(
            o.get("inside_source_root") for o in origins.values()):
        raise ValueError("wrong package import origin")
    for observed in evidence["production_calls_observed"]:
        if entry["source_file_sha256"].get(observed["path"]) != observed["sha256"]:
            raise ValueError("executed production source mismatch")
    verify_sources(entry, source)
    return summary


def collect(upstreams):
    frozen = freeze(upstreams)
    rows = []
    campaign_start = time.perf_counter()
    for project in PROJECTS:
        entry = next(e for e in frozen["projects"] if e["project"] == project)
        source = upstreams / project
        layouts = {role: read(ROOT / "results/v11/public_compiler" / project / name)
                   for role, name in LAYOUTS.items()}
        registry = layouts["original"]["registry"]
        for role, layout in layouts.items():
            path = f"results/v11/public_compiler/{project}/{LAYOUTS[role]}"
            if sha((ROOT / path).read_bytes()) != frozen["files_sha256"][path]:
                raise ValueError("frozen layout changed")
            if layout["registry"] != registry or layout["model"] != layouts["original"]["model"]:
                raise ValueError("inconsistent frozen registry or packet model")
            packet_bytes_reference(layout, [[]])
        for policy in POLICIES:
            for seed in SEEDS:
                remaining = 1200 - (time.perf_counter() - campaign_start)
                if remaining <= 0:
                    raise TimeoutError("total campaign budget exhausted; preserve completed cases")
                directory = OUT / project / policy / str(seed)
                directory.mkdir(parents=True, exist_ok=False)
                evidence_path = directory / "pytest_evidence.json"
                cmd = [sys.executable, "-m", "pytest", "-q", "--tb=short", "-p",
                       "experiments_v11.public_probe", "-p", "experiments_v12.schedule_probe",
                       "-p", "_hypothesis_pytestplugin", "-p", "pytest_mypy_plugins.collect",
                       "--hypothesis-seed=20261021"]
                env = dict(os.environ, PYTEST_DISABLE_PLUGIN_AUTOLOAD="1", PYTHONHASHSEED="0",
                           PYTHONPATH=str(ROOT), PATH=str(Path(sys.executable).parent) + os.pathsep + os.environ.get("PATH", ""),
                           HACT_V11_PROBE_OUTPUT=str(evidence_path), HACT_V11_SOURCE_ROOT=str(source),
                           HACT_V11_TARGET_MODULES=",".join(entry["target_modules"]),
                           HACT_V12_SCHEDULE_POLICY=policy, HACT_V12_SCHEDULE_SEED=str(seed))
                receipt = {"project": project, "policy": policy, "seed": seed,
                           "started_at": stamp(), "command": cmd, "cwd": str(source),
                           "environment_sha256": sha(canonical(environment())),
                           "frozen_manifest_sha256": sha((OUT / "FROZEN_MANIFEST.json").read_bytes())}
                started = time.perf_counter()
                try:
                    proc = subprocess.run(cmd, cwd=source, env=env, capture_output=True,
                                          text=True, timeout=min(180, remaining))
                    receipt["returncode"] = proc.returncode
                    log = proc.stdout + "\n[stderr]\n" + proc.stderr
                except subprocess.TimeoutExpired as exc:
                    receipt.update(returncode=None, timeout=True)
                    log = "\n".join(x.decode(errors="replace") if isinstance(x, bytes) else x
                                    for x in (exc.stdout or "", exc.stderr or ""))
                receipt["wall_seconds"] = time.perf_counter() - started
                (directory / "pytest.log").write_text(log)
                try:
                    evidence = read(evidence_path)
                    receipt.update(check_run(evidence, receipt, entry, source, policy, seed, registry))
                    costs = {}
                    for role, layout in layouts.items():
                        index = {cid: i for i, cid in enumerate(layout["registry"])}
                        waves = [[index[cid] for cid in evidence["executed"][i:i + 8]]
                                 for i in range(0, len(evidence["executed"]), 8)]
                        costs[role] = packet_bytes_reference(layout, [waves])[0]
                    receipt.update(status="PASS", costs=costs, evidence_sha256=sha(evidence_path.read_bytes()),
                                   gains_vs_original={k: 100 * (costs["original"] - v) / costs["original"]
                                                      for k, v in costs.items()},
                                   cap32_gain_vs_historical=100 * (costs["historical"] - costs["cap32"]) / costs["historical"])
                except (ValueError, KeyError, FileNotFoundError) as exc:
                    receipt.update(status="UNKNOWN" if receipt.get("timeout") else "VOID", reason=str(exc))
                receipt["ended_at"] = stamp()
                write_json(directory / "receipt.json", receipt)
                rows.append(receipt)
                write_json(OUT / "SUMMARY.json", {"runs": rows, "complete": len(rows) == 30,
                           "status_counts": dict(Counter(row["status"] for row in rows)),
                           "manifest_sha256": sha((OUT / "FROZEN_MANIFEST.json").read_bytes())})
                print(json.dumps({k: receipt.get(k) for k in
                                  ("project", "policy", "seed", "status", "n", "counts", "gains_vs_original", "reason")}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--upstreams", type=Path, required=True)
    args = parser.parse_args()
    collect(args.upstreams.resolve())
