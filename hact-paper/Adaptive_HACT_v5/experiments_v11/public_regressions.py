"""Frozen exploratory historical-module transplants under release test contracts.

These are actual historical source regressions, not native parent revisions or
confirmed natural-bug benchmark instances. No candidate is selected by a test
outcome or by a layout cost. Both revealing and unrevealing cases are retained.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

from experiments_v11.public_collect import (
    ROOT, OUTPUT, PROJECTS, canonical, git, sha, stamp, validate_evidence, write_json,
)


TARGET = ROOT / "results/v11/public_regressions"


def pytest_filename(path):
    p = Path(path)
    return path.startswith(("tests/", "testing/")) and p.suffix == ".py" and p.name.startswith("test_")


def select_candidates(upstreams):
    entries = []
    for name, repo, tag, modules in PROJECTS:
        source = upstreams / name
        lines = git(source, "log", "--first-parent", "--max-count=100", "--format=%H\t%s", tag).decode().splitlines()
        chosen, exclusions = [], []
        for line in lines:
            commit, subject = line.split("\t", 1)
            if not re.search(r"\b(fix(?:es|ed)?|bugs?)\b", subject, re.I):
                continue
            try:
                parent = git(source, "rev-parse", commit + "^1").decode().strip()
                paths = git(source, "diff", "--name-only", parent, commit).decode().splitlines()
            except subprocess.CalledProcessError:
                exclusions.append({"commit": commit, "reason": "parent outside fetched history"})
                continue
            production = [p for p in paths if p.startswith("src/") and p.endswith(".py")]
            tests = [p for p in paths if pytest_filename(p)]
            if not production or not tests:
                continue
            blobs = {}
            missing = []
            for path in production:
                try:
                    old = git(source, "show", parent + ":" + path)
                    fixed = git(source, "show", commit + ":" + path)
                    release = (source / path).read_bytes()
                except (subprocess.CalledProcessError, FileNotFoundError):
                    missing.append(path)
                    continue
                blobs[path] = {"parent_sha256": sha(old), "fixed_sha256": sha(fixed),
                               "release_sha256": sha(release)}
            if missing:
                exclusions.append({"commit": commit, "reason": "production module absent in parent/fix/release",
                                   "paths": missing})
                continue
            chosen.append({"case_id": f"{name}_source_{len(chosen)}", "commit": commit,
                           "parent": parent, "subject": subject,
                           "production_paths": production, "test_paths": tests,
                           "blobs": blobs})
            if len(chosen) == 2:
                break
        entries.append({"project": name, "repository": repo, "tag": tag,
                        "release_commit": git(source, "rev-parse", tag + "^{commit}").decode().strip(),
                        "target_modules": list(modules), "candidates": chosen,
                        "selection_exclusions": exclusions})
    return entries


def freeze_regressions(upstreams):
    manifest = TARGET / "FROZEN_SOURCE_PLAN.json"
    if manifest.exists():
        return json.loads(manifest.read_text())
    result = {"schema": "hact-v11-exploratory-source-plan-1", "frozen_at": stamp(),
              "selection": {"history": "first100first-parent commits preceding or including selected tag",
                            "subject_regex": r"\b(fix(?:es|ed)?|bugs?)\b",
                            "production": "modified src/**/*.py present in parent,fix,release",
                            "tests": "modified tests/test_*.py or testing/test_*.py",
                            "count": "first two eligible commits per project; fewer retained if absent",
                            "outcome_filter": "none"},
              "execution": {"source": "release snapshot with each chosen commit's changed production modules replaced by parent blobs",
                            "tests": "entire unmodified release test contract", "maxfail": 1,
                            "timeout_seconds": 180, "control": "selected release run0 from public-check cohort"},
              "interpretation": "historical module transplants; no claim of native parent revisions or source-bug attribution",
              "projects": select_candidates(upstreams)}
    result["candidate_count"] = sum(len(e["candidates"]) for e in result["projects"])
    write_json(manifest, result)
    return result


def run_case(entry, case, upstreams, work):
    directory = TARGET / entry["project"] / case["case_id"]
    if (directory / "receipt.json").exists():
        return json.loads((directory / "receipt.json").read_text())
    original = upstreams / entry["project"]
    isolated = work / case["case_id"]
    if isolated.exists():
        raise ValueError("refuse to overwrite an existing isolated checkout")
    shutil.copytree(original, isolated, ignore=shutil.ignore_patterns(
        ".git", "__pycache__", ".pytest_cache", ".hypothesis", ".mypy_cache", "*.egg-info"))
    for rel in case["production_paths"]:
        raw = git(original, "show", case["parent"] + ":" + rel)
        if sha(raw) != case["blobs"][rel]["parent_sha256"]:
            raise ValueError("frozen parent blob changed")
        (isolated / rel).write_bytes(raw)
    directory.mkdir(parents=True, exist_ok=True)
    evidence_path = directory / "pytest_evidence.json"
    cmd = [sys.executable, "-m", "pytest", "-q", "--tb=short", "--maxfail=1",
           "-p", "experiments_v11.public_probe", "-p", "_hypothesis_pytestplugin",
           "-p", "pytest_mypy_plugins.collect", "--hypothesis-seed=20261021"]
    env = dict(os.environ, PYTEST_DISABLE_PLUGIN_AUTOLOAD="1", PYTHONHASHSEED="0",
               PYTHONPATH=str(isolated / "src") + os.pathsep + str(ROOT),
               PATH=str(Path(sys.executable).parent) + os.pathsep + os.environ.get("PATH", ""),
               HACT_V11_PROBE_OUTPUT=str(evidence_path), HACT_V11_SOURCE_ROOT=str(isolated),
               HACT_V11_TARGET_MODULES=",".join(entry["target_modules"]))
    receipt = {"case_id": case["case_id"], "project": entry["project"], "started_at": stamp(),
               "command": cmd, "source_case": case, "release_commit": entry["release_commit"],
               "isolated_source": str(isolated), "collector_sha256": sha(Path(__file__).read_bytes()),
               "probe_sha256": sha((ROOT / "experiments_v11/public_probe.py").read_bytes())}
    started = time.perf_counter()
    try:
        run = subprocess.run(cmd, cwd=isolated, env=env, capture_output=True, text=True, timeout=180)
        receipt["returncode"] = run.returncode
        log = run.stdout + "\n[stderr]\n" + run.stderr
    except subprocess.TimeoutExpired as error:
        receipt.update(returncode=None, timeout=True)
        chunks = [error.stdout or b"", error.stderr or b""]
        log = "\n".join(x.decode(errors="replace") if isinstance(x, bytes) else x for x in chunks)
    receipt["wall_seconds"] = time.perf_counter() - started
    (directory / "pytest.log").write_text(log)
    if evidence_path.exists():
        evidence = json.loads(evidence_path.read_text())
        evidence["collected_registry"] = evidence["registry"]
        evidence["registry"] = sorted(evidence["registry"])
        try:
            summary = validate_evidence(evidence, require_complete=False)
            if evidence["collection_errors"] or not evidence["registry"]:
                raise ValueError("collection failure")
            if not evidence.get("session_finished") or receipt.get("timeout"):
                raise ValueError("unfinished session")
            if not all(o.get("inside_source_root") for o in evidence["package_origins"].values()):
                raise ValueError("package imported outside isolated transplant source")
            if not evidence["production_calls_observed"]:
                raise ValueError("no isolated production call observed")
            receipt.update(summary, eligible=True)
            reference_path = ROOT / "results/v11/public_checks_normalized" / entry["project"] / "run_0/pytest_evidence.json"
            reference = json.loads(reference_path.read_text())["registry"]
            receipt["registry_matches_release"] = evidence["registry"] == reference
            receipt["eligible_for_paired_costs"] = receipt["registry_matches_release"]
            if not receipt["registry_matches_release"]:
                receipt["paired_cost_exclusion"] = "source-dependent collection changed semantic ID set"
        except ValueError as error:
            receipt.update(eligible=False, exclusion=str(error))
        write_json(evidence_path, evidence)
        report = {"snapshot": sha(canonical({"release": entry["release_commit"], "case": case})),
                  "checker": sha(canonical(cmd)),
                  "environment": sha(canonical({"python": sys.version, "probe": receipt["probe_sha256"]})),
                  "registry_hash": sha(canonical(evidence["registry"])),
                  "locally_authorized": False, "source_transplant": True,
                  "project": entry["project"], "case": case["case_id"]}
        write_json(directory / "report.json", report)
        receipt["evidence_sha256"] = sha(evidence_path.read_bytes())
    else:
        receipt.update(eligible=False, exclusion="startup failed before recorder output")
    if not receipt.get("eligible"):
        receipt["eligible_for_paired_costs"] = False
    receipt["ended_at"] = stamp()
    write_json(directory / "receipt.json", receipt)
    print(json.dumps({k: receipt.get(k) for k in
                      ("case_id", "eligible", "n", "completed", "counts", "exclusion")}), flush=True)
    return receipt


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--upstreams", type=Path, required=True)
    p.add_argument("--work", type=Path)
    p.add_argument("--freeze-only", action="store_true")
    args = p.parse_args()
    plan = freeze_regressions(args.upstreams.resolve())
    if args.freeze_only:
        print(json.dumps({"candidate_count": plan["candidate_count"],
                          "per_project": {e["project"]: len(e["candidates"]) for e in plan["projects"]}}))
        return
    if not args.work:
        p.error("--work is required to execute isolated source transplants")
    args.work.mkdir(parents=True, exist_ok=True)
    receipts = [run_case(entry, case, args.upstreams.resolve(), args.work.resolve())
                for entry in plan["projects"] for case in entry["candidates"]]
    write_json(TARGET / "COLLECTION_SUMMARY.json", {"schema": "hact-v11-source-regression-collection-1",
               "completed_at": stamp(), "plan_sha256": sha((TARGET / "FROZEN_SOURCE_PLAN.json").read_bytes()),
               "cases": receipts})


if __name__ == "__main__":
    main()
