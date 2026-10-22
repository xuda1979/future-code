"""Freeze and collect actual upstream suite traces without test selection.

Run from the artifact root with the isolated evaluation interpreter:
  python -m experiments_v11.public_collect --upstreams /path/to/clones

Source checkout/install is explicit, outside this script. The fixed manifest
is immutable once written. Five process runs are collected in declaration
order; no collection decision depends on HACT outcomes.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "results/v11/public_checks"
PROJECTS = (
    ("click", "pallets/click", "8.2.1", ("click",)),
    ("jinja", "pallets/jinja", "3.1.6", ("jinja2",)),
    ("packaging", "pypa/packaging", "25.0", ("packaging",)),
    ("pluggy", "pytest-dev/pluggy", "1.6.0", ("pluggy",)),
    ("attrs", "python-attrs/attrs", "25.3.0", ("attr", "attrs")),
    ("exceptiongroup", "agronholm/exceptiongroup", "1.3.0", ("exceptiongroup",)),
)
SPLITS = ("training", "training", "validation", "heldout", "heldout")


def stamp():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def git(path, *args):
    return subprocess.check_output(["git", "-C", str(path), *args])


def freeze(upstreams):
    target = OUTPUT / "FROZEN_MANIFEST.json"
    if target.exists():
        return json.loads(target.read_text())
    entries = []
    for name, repo, tag, modules in PROJECTS:
        source = upstreams / name
        commit = git(source, "rev-parse", "HEAD").decode().strip()
        tag_commit = git(source, "rev-parse", f"{tag}^{{commit}}").decode().strip()
        if commit != tag_commit or git(source, "status", "--porcelain", "-uno"):
            raise ValueError(f"{name}: checkout must match clean declared tag")
        names = git(source, "ls-files", "-z").decode().split("\0")
        files = {n: sha((source / n).read_bytes()) for n in names
                 if n and (source / n).is_file()}
        entries.append({"project": name, "repository": repo, "tag": tag,
                        "commit": commit, "target_modules": list(modules),
                        "source_file_sha256": files,
                        "source_manifest_sha256": sha(canonical(files))})
    env = {"python": sys.version, "platform": platform.platform(),
           "machine": platform.machine(), "cpu_count": os.cpu_count(),
           "packages": sorted({d.metadata["Name"]: d.version
                               for d in importlib.metadata.distributions()}.items())}
    contract = ROOT / "docs/V11_RESEARCH_CONTRACT.md"
    result = {"schema": "hact-v11-public-cohort-1", "frozen_at": stamp(),
              "contract_sha256": sha(contract.read_bytes()),
              "source_status": "unmodified tagged upstream releases",
              "projects": entries, "splits": list(SPLITS),
              "wave_size": 8, "timeout_seconds_per_run": 180,
              "environment": env,
              "scope": "normal repeated suites; not source changes or natural bugs"}
    write_json(target, result)
    return result


def validate_evidence(evidence, *, require_complete=True):
    registry, executed = evidence["registry"], evidence["executed"]
    if len(registry) != len(set(registry)) or len(executed) != len(set(executed)):
        raise ValueError("duplicate semantic ID")
    if not set(executed) <= set(registry):
        raise ValueError("undeclared executed semantic ID")
    if require_complete and set(registry) != set(executed):
        raise ValueError("suite execution is not complete")
    for cid in executed:
        rec = evidence["records"][cid]
        if rec["status"] not in ("PASS", "FAIL", "UNKNOWN"):
            raise ValueError("invalid canonical status")
        if rec["wall_seconds"] is None or rec["wall_seconds"] < 0:
            raise ValueError("invalid observed runtime")
    return {"n": len(registry), "completed": len(executed),
            "counts": dict(Counter(evidence["records"][cid]["status"]
                                   for cid in executed)),
            "complete": set(registry) == set(executed)}


def collect_project(entry, upstreams, *, output_base=OUTPUT, allow_order_variation=False):
    name = entry["project"]
    source = upstreams / name
    records = []
    reference_registry = None
    for run_id, split in enumerate(SPLITS):
        directory = output_base / name / f"run_{run_id}"
        receipt = directory / "receipt.json"
        if receipt.exists():
            records.append(json.loads(receipt.read_text()))
            reference_registry = json.loads((directory / "pytest_evidence.json").read_text())["registry"]
            continue
        directory.mkdir(parents=True, exist_ok=True)
        evidence_path = directory / "pytest_evidence.json"
        cmd = [sys.executable, "-m", "pytest", "-q", "--tb=short", "-p",
               "experiments_v11.public_probe", "-p", "_hypothesis_pytestplugin",
               "-p", "pytest_mypy_plugins.collect", "--hypothesis-seed=20261021"]
        # The optional mypy collector is an upstream test dependency. It adds
        # YAML tests only where the project's own configured testpaths include them.
        env = dict(os.environ, PYTEST_DISABLE_PLUGIN_AUTOLOAD="1",
                   PYTHONHASHSEED="0", PYTHONPATH=str(ROOT),
                   PATH=str(Path(sys.executable).parent) + os.pathsep + os.environ.get("PATH", ""),
                   HACT_V11_PROBE_OUTPUT=str(evidence_path),
                   HACT_V11_SOURCE_ROOT=str(source),
                   HACT_V11_TARGET_MODULES=",".join(entry["target_modules"]))
        started = time.perf_counter()
        record = {"project": name, "run_id": run_id, "split": split,
                  "started_at": stamp(), "command": cmd,
                  "cwd": str(source), "source_commit": entry["commit"]}
        try:
            run = subprocess.run(cmd, cwd=source, env=env, capture_output=True,
                                 text=True, timeout=180)
            record["returncode"] = run.returncode
            log = run.stdout + "\n[stderr]\n" + run.stderr
        except subprocess.TimeoutExpired as error:
            record["returncode"] = None
            record["timeout"] = True
            chunks = [error.stdout or b"", error.stderr or b""]
            log = "\n".join(c.decode(errors="replace") if isinstance(c, bytes) else c
                             for c in chunks)
        record["process_wall_seconds"] = time.perf_counter() - started
        (directory / "pytest.log").write_text(log)
        if evidence_path.exists():
            evidence = json.loads(evidence_path.read_text())
            try:
                summary = validate_evidence(evidence)
                if not evidence.get("session_finished") or record.get("timeout"):
                    raise ValueError("session did not finish within declared budget")
                if evidence["collection_errors"] or not evidence["registry"]:
                    raise ValueError("collection failed or empty registry")
                if reference_registry is None:
                    reference_registry = evidence["registry"]
                if (set(reference_registry) != set(evidence["registry"]) or
                        (not allow_order_variation and reference_registry != evidence["registry"])):
                    raise ValueError("registry changed across snapshot repeats")
                origins = evidence["package_origins"]
                if not origins or not all(o.get("inside_source_root") for o in origins.values()):
                    raise ValueError("target package imported outside source checkout")
                if not evidence["production_calls_observed"]:
                    raise ValueError("no production call origin observed")
                record.update(summary, eligible=True)
            except ValueError as error:
                record.update(eligible=False, exclusion=str(error))
            registry_hash = sha(canonical(evidence["registry"]))
            report = {"snapshot": entry["source_manifest_sha256"],
                      "checker": sha(canonical(cmd)),
                      "environment": sha(canonical({"python": sys.version,
                                                   "platform": platform.platform()})),
                      "registry_hash": registry_hash,
                      "locally_authorized": bool(record.get("eligible")) and
                      len(evidence["registry"]) > 0 and
                      all(r["status"] == "PASS" for r in evidence["records"].values()),
                      "project": name, "run_id": run_id, "split": split}
            write_json(directory / "report.json", report)
            record["evidence_sha256"] = sha(evidence_path.read_bytes())
        else:
            record.update(eligible=False, exclusion="no complete recorder output")
        record["ended_at"] = stamp()
        write_json(receipt, record)
        records.append(record)
        print(json.dumps({k: record.get(k) for k in
                          ("project", "run_id", "split", "eligible", "n", "counts", "exclusion")}), flush=True)
        # Unsupported execution environments cannot supply training or holdout
        # evidence. Retain the first attempt instead of repeating an unchanged failure.
        if not record["eligible"]:
            break
    return records


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--upstreams", type=Path, required=True)
    p.add_argument("--projects", nargs="*")
    p.add_argument("--freeze-only", action="store_true")
    p.add_argument("--campaign", help="Separate attempt directory; raw attempts are retained")
    p.add_argument("--allow-order-variation", action="store_true",
                   help="Permit equal ID sets; use canonical normalization before analysis")
    p.add_argument("--normalize", action="store_true")
    args = p.parse_args()
    cohort = freeze(args.upstreams.resolve())
    if args.normalize:
        normalize_existing()
        return
    if args.freeze_only:
        print(OUTPUT / "FROZEN_MANIFEST.json")
        return
    results = []
    output_base = OUTPUT
    if args.campaign:
        if not args.campaign.replace("-", "").isalnum():
            raise ValueError("invalid campaign name")
        output_base = OUTPUT / ("attempt_" + args.campaign)
    for entry in cohort["projects"]:
        if args.projects and entry["project"] not in args.projects:
            continue
        results.extend(collect_project(entry, args.upstreams.resolve(),
                                       output_base=output_base,
                                       allow_order_variation=args.allow_order_variation))
    write_json(output_base / "COLLECTION_SUMMARY.json", {
        "schema": "hact-v11-public-collection-1", "updated_at": stamp(),
        "manifest_sha256": sha((OUTPUT / "FROZEN_MANIFEST.json").read_bytes()),
        "runs": results})


def normalize_existing():
    """Canonical semantic IDs; preserve source measurements and execution order.

    This is an explicitly recorded preanalysis instrumentation correction,
    approved before any HACT comparison on this cohort.
    """
    target = ROOT / "results/v11/public_checks_normalized"
    plan = target / "NORMALIZATION_MANIFEST.json"
    if not plan.exists():
        write_json(plan, {"schema": "hact-v11-normalization-plan-1", "frozen_at": stamp(),
                         "raw_cohort_manifest_sha256": sha((OUTPUT / "FROZEN_MANIFEST.json").read_bytes()),
                         "normalizer_source_sha256": sha(Path(__file__).read_bytes()),
                         "transformation": "registry sorted by semantic ID; actual executed/scheduled unchanged; collected_registry retained",
                         "eligibility": "all same declared IDs completed; phase/origin/collection checks; PASS/FAIL/UNKNOWN retained",
                         "jinja_input_campaign": "attempt_trio-repair",
                         "analysis_status": "normalization specified before HACT outcome comparisons",
                         "source": "raw files remain byte-identical, parent SHA256 attached to every output"})
    all_runs = []
    missing = []
    for name, _repo, _tag, _modules in PROJECTS:
        # Jinja's original missing-dependency attempt remains untouched.
        campaign = OUTPUT / "attempt_trio-repair" if name == "jinja" else OUTPUT
        reference = None
        project_rows = []
        for run_id, split in enumerate(SPLITS):
            source = campaign / name / f"run_{run_id}"
            raw = source / "pytest_evidence.json"
            report_path = source / "report.json"
            receipt_path = source / "receipt.json"
            if not all(p.exists() for p in (raw, report_path, receipt_path)):
                missing.append({"project": name, "run_id": run_id, "reason": "missing raw run"})
                continue
            evidence = json.loads(raw.read_text())
            receipt = json.loads(receipt_path.read_text())
            report = json.loads(report_path.read_text())
            try:
                summary = validate_evidence(evidence)
                if (evidence["collection_errors"] or not evidence.get("session_finished")
                        or not evidence["registry"] or receipt.get("timeout")):
                    raise ValueError("unfinished or failed collection")
                registry = sorted(evidence["registry"])
                if reference is None:
                    reference = registry
                if registry != reference:
                    raise ValueError("semantic ID set changed")
                if (not evidence["package_origins"] or
                        not all(o.get("inside_source_root") for o in evidence["package_origins"].values())):
                    raise ValueError("foreign package origin")
                if not evidence["production_calls_observed"]:
                    raise ValueError("missing production execution audit")
                evidence["collected_registry"] = evidence["registry"]
                evidence["registry"] = registry
                evidence["normalization"] = {
                    "kind": "canonical-semantic-registry-only",
                    "parent_path": str(raw.relative_to(ROOT)),
                    "parent_sha256": sha(raw.read_bytes()),
                    "execution_order_changed": False}
                report["registry_hash"] = sha(canonical(registry))
                report["normalization_parent_sha256"] = sha(report_path.read_bytes())
                receipt.update(summary, eligible=True, split=split,
                               raw_receipt_sha256=sha(receipt_path.read_bytes()),
                               normalization="canonical registry; unchanged executions")
                receipt.pop("exclusion", None)
                destination = target / name / f"run_{run_id}"
                write_json(destination / "pytest_evidence.json", evidence)
                write_json(destination / "report.json", report)
                write_json(destination / "receipt.json", receipt)
                project_rows.append(receipt)
            except ValueError as error:
                missing.append({"project": name, "run_id": run_id, "reason": str(error)})
        all_runs.extend(project_rows)
    result = {"schema": "hact-v11-normalized-public-collection-1",
              "normalized_at": stamp(), "runs": all_runs, "missing": missing,
              "complete": len(all_runs) == len(PROJECTS) * len(SPLITS) and not missing,
              "scope": "ID ordering correction; raw evidence and observed execution order retained"}
    write_json(target / "COLLECTION_SUMMARY.json", result)
    print(json.dumps({"normalized_runs": len(all_runs), "complete": result["complete"], "missing": missing}))


if __name__ == "__main__":
    main()
