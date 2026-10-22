"""Frozen-split compiler evaluation on newly collected upstream pytest traces.

Fit all projects using runs 0--1 and validate on run 2 before opening held-out
runs 3--4. No status is filtered out: FAIL and UNKNOWN are retained. These are
repeated executions of one snapshot per project, not source-change replication.
The method and selected layouts are persisted before held-out cost evaluation.

Reported packet totals use a separate literal dictionary-tree/set evaluator,
not Layout.cost, efficient_costs, the DP objective, or optimizer output scores.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import multiprocessing
from pathlib import Path
import platform
import sys
import time
from datetime import datetime, timezone

from ichact.fullwave import refine_fullwave
from ichact.layout import Layout, cluster_order, jaccard_affinity
from ichact.practical import balanced_layout

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "results/v11/public_checks_normalized"
OUT = ROOT / "results/v11/public_compiler"
PROJECTS = ("click", "jinja", "packaging", "pluggy", "attrs", "exceptiongroup")
CAPS = (32, 64)
METHOD_FILES = ("experiments_v11/public_compiler_study.py", "ichact/fullwave.py",
                "ichact/layout.py", "ichact/practical.py", "hact/tree.py")
CONTRACT = {
    "schema": "hact-v11-public-compiler-contract-2",
    "training_runs": [0, 1], "validation_runs": [2], "heldout_runs": [3, 4],
    "projects": list(PROJECTS), "primary_cap": 32, "sensitivity_cap": 64,
    "wave_width": 8,
    "wave_semantics": "final observed completion order, consecutive groups of at most eight",
    "primary_metric": "strict-epoch padded packet bytes including complete initial build",
    "primary_comparison": "validation-selected fullwave32 catalogue vs historical compact catalogue",
    "selection": "original compact first, pairwise compact second, then same-order refined; strict lower cost only",
    "eligibility": "all five runs present, eligible collection, identical ordered registry and source identity",
    "failures": "test FAIL and UNKNOWN retained; collection/environment failures excluded with reasons",
    "fit_budget_seconds_per_project": 120,
    "max_dense_registry": 2048,
    "compiler_memory_budget_bytes": 2 * 1024 ** 3,
    "resource_admission": "larger registries: optimization UNKNOWN; complete original compact layout only as explicit service fallback, excluded from primary comparison",
    "normalization": "separately persisted canonical-sorted semantic registry; raw collected order and actual completion order unchanged in parent records",
    "preanalysis_amendment": "PROTOCOL_DEVIATION.json preserves old method and receipts; no heldout compiler costs had been opened",
    "interpretation": "six convenience-sampled snapshots; descriptive repeated execution costs; no production-demand or higher-order-causality claim",
}


def _stamp():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _value_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def packet_bytes_reference(layout, episodes):
    """Independent full-episode cost from persisted tree dictionaries.

    Literal semantic-ID sets reconstruct each node. Every episode pays the
    complete initial tree, including empty and partially executed episodes.
    """
    registry, order, model = layout["registry"], layout["order"], layout["model"]
    n = len(registry)
    if not n or len(set(registry)) != n or sorted(order) != list(range(n)):
        raise ValueError("invalid registry/permutation in independent reference")
    if any(type(i) is not int for i in order):
        raise ValueError("noninteger permutation")
    prices, memberships = [], [[] for _ in registry]

    def walk(node):
        lo, hi, children = node["lo"], node["hi"], node["children"]
        if type(lo) is not int or type(hi) is not int or not 0 <= lo <= hi < n:
            raise ValueError("invalid literal interval")
        if not children:
            if lo != hi:
                raise ValueError("nonsingleton leaf")
            return [lo]
        if not 2 <= len(children) <= (model["cap"] - model["header"]) // model["card"]:
            raise ValueError("packet arity/cap violation")
        leaves = []
        for child in children:
            leaves.extend(walk(child))
        if leaves != list(range(lo, hi + 1)):
            raise ValueError("gaps or overlaps in tree")
        packet = len(prices)
        prices.append(model["header"] + len(children) * model["card"])
        for position in leaves:
            memberships[order[position]].append(packet)
        return leaves

    if walk(layout["tree"]) != list(range(n)):
        raise ValueError("incomplete root coverage")
    totals = []
    for episode in episodes:
        total = sum(prices)
        for wave in episode:
            if any(type(i) is not int or not 0 <= i < n for i in wave):
                raise ValueError("unknown completion index")
            touched = {packet for member in set(wave) for packet in memberships[member]}
            total += sum(prices[packet] for packet in touched)
        totals.append(total)
    return totals


def _run(project, run):
    directory = DATA / project / f"run_{run}"
    paths = {name: directory / (name + ".json")
             for name in ("pytest_evidence", "report", "receipt")}
    if any(not path.is_file() for path in paths.values()):
        raise ValueError(f"missing run {run} files")
    values = {name: json.loads(path.read_text()) for name, path in paths.items()}
    evidence, report, receipt = values["pytest_evidence"], values["report"], values["receipt"]
    if not receipt.get("eligible", False):
        raise ValueError(f"run {run} collection ineligible: {receipt.get('exclusion')}")
    if evidence.get("collection_errors"):
        raise ValueError(f"run {run} has collection errors")
    registry = evidence.get("registry", [])
    if not registry or len(set(registry)) != len(registry):
        raise ValueError(f"run {run} empty/duplicate registry")
    executed = evidence.get("executed", [])
    if len(set(executed)) != len(executed) or not set(executed) <= set(registry):
        raise ValueError(f"run {run} invalid completion registry")
    if any(cid not in evidence.get("records", {}) for cid in executed):
        raise ValueError(f"run {run} missing final records")
    if any(evidence["records"][cid].get("status") not in ("PASS", "FAIL", "UNKNOWN") for cid in executed):
        raise ValueError(f"run {run} invalid status")
    index = {cid: i for i, cid in enumerate(registry)}
    episode = [[index[cid] for cid in executed[i:i + CONTRACT["wave_width"]]]
               for i in range(0, len(executed), CONTRACT["wave_width"])]
    return {"registry": tuple(registry), "episode": episode, "report": report,
            "status_counts": {status: sum(evidence["records"][cid]["status"] == status for cid in executed)
                              for status in ("PASS", "FAIL", "UNKNOWN")},
            "declared": len(registry), "executed": len(executed),
            "provenance": {name: {"path": str(path.relative_to(ROOT)), "sha256": _sha(path),
                                  "bytes": path.stat().st_size} for name, path in paths.items()}}


def _same_identity(runs):
    registry = runs[0]["registry"]
    if any(run["registry"] != registry for run in runs):
        raise ValueError("ordered registry changed across runs")
    for field in ("snapshot", "checker", "environment", "registry_hash"):
        baseline = runs[0]["report"].get(field)
        if baseline is None or any(run["report"].get(field) != baseline for run in runs):
            raise ValueError(f"bound {field} identity changed across runs")


def _fit_payload(project):
    started = time.perf_counter()
    runs = [_run(project, i) for i in (0, 1, 2)]
    _same_identity(runs)
    registry = runs[0]["registry"]
    training, validation = [r["episode"] for r in runs[:2]], [runs[2]["episode"]]
    if len(registry) > CONTRACT["max_dense_registry"]:
        # Do not allocate the dense affinity matrix or Python O(n^2) heap.
        # One matrix alone exceeds the 2 GiB budget at n=26,948; the explicit
        # lower admission cap also leaves room for two matrices and the heap.
        start = time.perf_counter()
        original = balanced_layout(registry).to_dict()
        fallback_compile_seconds = time.perf_counter() - start
        return {"schema": "hact-v11-public-compiler-fit-2", "status": "UNKNOWN", "project": project,
                "reason": "dense compiler resource admission refused; original compact service fallback only",
                "frozen_at": _stamp(), "contract_sha256": _value_hash(CONTRACT), "heldout_opened": False,
                "registry_size": len(registry), "optimization_available": False,
                "dense_matrix_lower_bound_bytes": len(registry) ** 2 * 8,
                "resource_limit": CONTRACT["max_dense_registry"],
                "fallback_layout": original, "fallback_compile_seconds": fallback_compile_seconds,
                "fallback_train_per_run_bytes": packet_bytes_reference(original, training),
                "fallback_validation_bytes": packet_bytes_reference(original, validation)[0],
                "input_manifest": {str(i): r["provenance"] for i, r in enumerate(runs)},
                "identity": {field: runs[0]["report"][field]
                             for field in ("snapshot", "checker", "environment", "registry_hash")},
                "scope": "fallback is excluded from primary optimization comparisons; no registry clipping"}
    start = time.perf_counter()
    original = balanced_layout(registry)
    order = cluster_order(jaccard_affinity(training, len(registry)))
    learned = balanced_layout(registry, order)
    compact_compile_seconds = time.perf_counter() - start
    layouts = {"original_compact": original, "pairwise_compact": learned}
    refinement = {}
    compile_seconds = {"historical_compact": compact_compile_seconds}
    for cap in CAPS:
        refinement[str(cap)] = {}
        elapsed = compact_compile_seconds
        for name in ("original_compact", "pairwise_compact"):
            refined_name = f"{name}_refined{cap}"
            refined, info = refine_fullwave(layouts[name], training, max_subtree_leaves=cap)
            layouts[refined_name] = refined
            refinement[str(cap)][name] = info
            elapsed += info["elapsed_seconds"]
        compile_seconds[f"fullwave{cap}"] = elapsed
    serialized = {name: value.to_dict() for name, value in layouts.items()}
    start = time.perf_counter()
    train_scores = {name: packet_bytes_reference(value, training) for name, value in serialized.items()}
    independent_training_audit_seconds = time.perf_counter() - start
    validation_scores, validation_seconds = {}, {}
    for name, value in serialized.items():
        start = time.perf_counter()
        validation_scores[name] = packet_bytes_reference(value, validation)[0]
        validation_seconds[name] = time.perf_counter() - start
    for cap in CAPS:
        for parent in ("original_compact", "pairwise_compact"):
            info = refinement[str(cap)][parent]
            if sum(train_scores[parent]) != info["training_total_before"]:
                raise AssertionError("independent training baseline differs")
            if sum(train_scores[f"{parent}_refined{cap}"]) != info["training_total_after"]:
                raise AssertionError("independent refinement cost differs")
    historical = ("original_compact", "pairwise_compact")
    selected = {"historical_compact": min(historical, key=validation_scores.get)}
    compile_seconds["historical_compact"] += sum(validation_seconds[name] for name in historical)
    for cap in CAPS:
        candidates = (*historical, *(f"{name}_refined{cap}" for name in historical))
        selected[f"fullwave{cap}"] = min(candidates, key=validation_scores.get)
        compile_seconds[f"fullwave{cap}"] += sum(validation_seconds[name] for name in candidates)
    return {"schema": "hact-v11-public-compiler-fit-2", "status": "PASS", "project": project,
            "frozen_at": _stamp(), "contract_sha256": _value_hash(CONTRACT),
            "heldout_opened": False,
            "training_runs": [0, 1], "validation_runs": [2], "heldout_runs": [3, 4],
            "registry_size": len(registry), "selected": selected,
            "train_per_run_bytes": train_scores, "validation_bytes": validation_scores,
            "compile_seconds": compile_seconds,
            "compile_scope": "training fit, candidate construction and full validation scoring; independent training audit separate",
            "timing_load": "single local host; other collection processes may be active; descriptive only",
            "validation_scoring_seconds": validation_seconds,
            "independent_training_audit_seconds": independent_training_audit_seconds,
            "fit_and_audit_total_seconds": time.perf_counter() - started,
            "refinement": refinement, "layouts": serialized,
            "input_manifest": {str(i): r["provenance"] for i, r in enumerate(runs)},
            "training_status_counts": [r["status_counts"] for r in runs],
            "identity": {field: runs[0]["report"][field]
                         for field in ("snapshot", "checker", "environment", "registry_hash")},
            "reference": "literal dictionary-tree/set evaluator; no Layout.cost used for reported bytes"}


def _fit_worker(project, output):
    try:
        value = _fit_payload(project)
    except Exception as exc:
        value = {"status": "UNKNOWN", "project": project, "phase": "fit",
                 "reason": f"{type(exc).__name__}: {exc}", "at": _stamp(), "heldout_opened": False}
    _write(Path(output), value)


def fit_projects(projects=None):
    projects = PROJECTS if projects is None else tuple(projects)
    if not projects or len(set(projects)) != len(projects) or not set(projects) <= set(PROJECTS):
        raise ValueError("fit projects must be a nonempty unique subset of the frozen frame")
    OUT.mkdir(parents=True, exist_ok=True)
    contract_path = OUT / "CONTRACT.json"
    if contract_path.exists() and json.loads(contract_path.read_text()) != CONTRACT:
        raise RuntimeError("refuse to replace a different frozen public compiler contract")
    _write(contract_path, CONTRACT)
    method_manifest = {name: {"sha256": _sha(ROOT / name), "bytes": (ROOT / name).stat().st_size}
                       for name in METHOD_FILES}
    if (DATA / "FROZEN_MANIFEST.json").exists():
        method_manifest["results/v11/public_checks_normalized/FROZEN_MANIFEST.json"] = {
            "sha256": _sha(DATA / "FROZEN_MANIFEST.json"),
            "bytes": (DATA / "FROZEN_MANIFEST.json").stat().st_size}
    normalization_manifest = DATA / "NORMALIZATION_MANIFEST.json"
    if not normalization_manifest.exists():
        raise RuntimeError("canonical-registry normalization must finish and freeze before fitting")
    method_manifest[str(normalization_manifest.relative_to(ROOT))] = {
        "sha256": _sha(normalization_manifest), "bytes": normalization_manifest.stat().st_size}
    method_path = OUT / "METHOD_MANIFEST.json"
    if method_path.exists() and json.loads(method_path.read_text()) != method_manifest:
        raise RuntimeError("fitting method/input sampling manifest changed after freezing")
    _write(method_path, method_manifest)
    summaries = []
    context = multiprocessing.get_context("spawn")
    for project in projects:
        directory = OUT / project
        receipt_path = directory / "fit_receipt.json"
        if receipt_path.exists():
            # A frozen fit is reused exactly. It must not be silently refitted
            # after held-out costs become available.
            value = json.loads(receipt_path.read_text())
            if value.get("contract_sha256") != _value_hash(CONTRACT):
                raise RuntimeError(f"incompatible frozen fit for {project}")
            summaries.append({"project": project, "status": value["status"], "reused": True})
            continue
        directory.mkdir(parents=True, exist_ok=True)
        worker_output = directory / "fit_payload.json"
        process = context.Process(target=_fit_worker, args=(project, str(worker_output)))
        process.start()
        process.join(CONTRACT["fit_budget_seconds_per_project"])
        if process.is_alive():
            process.terminate()
            process.join()
            value = {"status": "UNKNOWN", "project": project, "phase": "fit",
                     "reason": "compile wall-time budget exceeded", "heldout_opened": False,
                     "contract_sha256": _value_hash(CONTRACT), "at": _stamp()}
        elif not worker_output.exists():
            value = {"status": "UNKNOWN", "project": project, "phase": "fit",
                     "reason": f"fit worker exited {process.exitcode} without an artifact",
                     "heldout_opened": False, "contract_sha256": _value_hash(CONTRACT), "at": _stamp()}
        else:
            value = json.loads(worker_output.read_text())
            value["contract_sha256"] = _value_hash(CONTRACT)
        if value["status"] == "PASS":
            for name, layout in value.pop("layouts").items():
                _write(directory / ("layout_" + name + ".json"), layout)
            for alias, method in (("selected_layout", "fullwave32"),
                                  ("selected_layout_sensitivity", "fullwave64"),
                                  ("historical_layout", "historical_compact")):
                name = value["selected"][method]
                layout_path = directory / ("layout_" + name + ".json")
                _write(directory / (alias + ".json"), json.loads(layout_path.read_text()))
            value["layout_manifest"] = {path.name: {"sha256": _sha(path), "bytes": path.stat().st_size}
                                        for path in sorted(directory.glob("*layout*.json"))}
        elif "fallback_layout" in value:
            fallback = directory / "service_fallback_layout.json"
            _write(fallback, value.pop("fallback_layout"))
            value["fallback_layout_manifest"] = {"path": str(fallback.relative_to(ROOT)),
                                                  "sha256": _sha(fallback), "bytes": fallback.stat().st_size}
        _write(receipt_path, value)
        summaries.append({"project": project, "status": value["status"], "reason": value.get("reason")})
        print("public compiler fit", project, value["status"], value.get("reason", ""), flush=True)
    all_receipts = [OUT / name / "fit_receipt.json" for name in PROJECTS]
    if all(path.exists() for path in all_receipts):
        all_summaries = [{"project": name, "status": json.loads(path.read_text())["status"],
                          "fit_receipt_sha256": _sha(path)} for name, path in zip(PROJECTS, all_receipts)]
        _write(OUT / "FIT_FROZEN.json", {"at": _stamp(), "contract_sha256": _value_hash(CONTRACT),
                                         "heldout_opened": False, "projects": all_summaries})
    else:
        _write(OUT / "FIT_PROGRESS.json", {"at": _stamp(), "contract_sha256": _value_hash(CONTRACT),
                                           "heldout_opened": False, "fitted": summaries,
                                           "pending": [name for name, path in zip(PROJECTS, all_receipts)
                                                       if not path.exists()]})
    return summaries


def evaluate_projects():
    if not (OUT / "FIT_FROZEN.json").exists():
        raise RuntimeError("all project fitting decisions must freeze before opening any held-out run")
    for name, entry in json.loads((OUT / "METHOD_MANIFEST.json").read_text()).items():
        if _sha(ROOT / name) != entry["sha256"]:
            raise RuntimeError("method or frozen sampling manifest changed before held-out evaluation")
    rows, service_cases = [], []
    for project in PROJECTS:
        directory = OUT / project
        fit_path = directory / "fit_receipt.json"
        fit = json.loads(fit_path.read_text())
        if fit["status"] != "PASS":
            row = {"project": project, "status": "UNKNOWN", "reason": fit.get("reason"), "phase": "fit"}
            if "fallback_layout_manifest" in fit:
                try:
                    runs = [_run(project, i) for i in range(5)]
                    _same_identity(runs)
                    for paths in fit["input_manifest"].values():
                        for entry in paths.values():
                            if _sha(ROOT / entry["path"]) != entry["sha256"]:
                                raise ValueError("fitting input changed after resource admission")
                    entry = fit["fallback_layout_manifest"]
                    layout_path = ROOT / entry["path"]
                    if _sha(layout_path) != entry["sha256"]:
                        raise ValueError("service fallback layout changed")
                    fallback = json.loads(layout_path.read_text())
                    row["fallback_heldout_per_run_bytes"] = packet_bytes_reference(fallback, [runs[i]["episode"] for i in (3, 4)])
                    row["registry_size"] = fit["registry_size"]
                    row["fallback_compile_seconds"] = fit["fallback_compile_seconds"]
                    row["scope"] = "representation costs for explicit service fallback; excluded from primary optimization comparison"
                    for run in (3, 4):
                        service_cases.append({"project": project, "case": f"{project}_run_{run}",
                                              "evidence": runs[run]["provenance"]["pytest_evidence"]["path"],
                                              "report": runs[run]["provenance"]["report"]["path"],
                                              "layout": entry["path"], "compiler_status": "UNKNOWN",
                                              "layout_role": "original compact resource fallback"})
                except Exception as exc:
                    row["fallback_error"] = f"{type(exc).__name__}: {exc}"
            _write(directory / "evaluation.json", row)
            rows.append(row)
            continue
        try:
            # Check fitting-input immutability before opening held-out evidence.
            for paths in fit["input_manifest"].values():
                for entry in paths.values():
                    if _sha(ROOT / entry["path"]) != entry["sha256"]:
                        raise ValueError("fitting input changed after method freeze")
            runs = [_run(project, i) for i in range(5)]
            _same_identity(runs)
            for field, value in fit["identity"].items():
                if runs[0]["report"][field] != value:
                    raise ValueError("fit source identity differs at evaluation")
            layouts = {}
            for name, entry in fit["layout_manifest"].items():
                path = directory / name
                if _sha(path) != entry["sha256"]:
                    raise ValueError("selected layout changed after fitting")
                if name.startswith("layout_"):
                    layouts[name[len("layout_"):-5]] = json.loads(path.read_text())
            heldout = [runs[i]["episode"] for i in (3, 4)]
            per_run = {name: packet_bytes_reference(layout, heldout) for name, layout in layouts.items()}
            totals = {name: sum(value) for name, value in per_run.items()}
            for alias, winner in fit["selected"].items():
                totals[alias] = totals[winner]
            baseline = totals["historical_compact"]
            row = {"schema": "hact-v11-public-compiler-evaluation-1", "status": "PASS", "project": project,
                   "frozen_fit_sha256": _sha(fit_path), "evaluated_at": _stamp(),
                   "selected": fit["selected"], "heldout_per_run_bytes": per_run,
                   "heldout_total_bytes": totals,
                   "primary_saving_fraction": (baseline - totals["fullwave32"]) / baseline if baseline else 0.0,
                   "sensitivity_saving_fraction": (baseline - totals["fullwave64"]) / baseline if baseline else 0.0,
                   "compile_seconds": fit["compile_seconds"], "registry_size": fit["registry_size"],
                   "heldout_status_counts": [runs[i]["status_counts"] for i in (3, 4)],
                   "input_manifest": {str(i): run["provenance"] for i, run in enumerate(runs)},
                   "independence": "one snapshot per project; two held-out execution repeats, not independent changes",
                   "same_order_attribution": "topology refinement effect; does not isolate higher-order information"}
            for run in (3, 4):
                service_cases.append({"project": project, "case": f"{project}_run_{run}",
                                      "evidence": runs[run]["provenance"]["pytest_evidence"]["path"],
                                      "report": runs[run]["provenance"]["report"]["path"],
                                      "layout": str((directory / "selected_layout.json").relative_to(ROOT))})
        except Exception as exc:
            row = {"project": project, "status": "UNKNOWN", "phase": "evaluate",
                   "reason": f"{type(exc).__name__}: {exc}", "at": _stamp()}
        _write(directory / "evaluation.json", row)
        rows.append(row)
        print("public compiler evaluation", project, row["status"], row.get("primary_saving_fraction", row.get("reason")), flush=True)
    valid = [row for row in rows if row["status"] == "PASS"]
    summary = {"schema": "hact-v11-public-compiler-summary-1", "contract": CONTRACT,
               "status": "PASS" if len(valid) == len(PROJECTS) else "UNKNOWN",
               "eligible_projects": len(valid), "requested_projects": len(PROJECTS),
               "projects": rows, "environment": {"python": sys.version, "platform": platform.platform()},
               "primary": {"wins": sum(row["primary_saving_fraction"] > 0 for row in valid),
                           "ties": sum(row["primary_saving_fraction"] == 0 for row in valid),
                           "losses": sum(row["primary_saving_fraction"] < 0 for row in valid)},
               "inference": "descriptive project cases; no random-project population or agent-productivity inference"}
    _write(OUT / "SUMMARY.json", summary)
    _write(OUT / "SERVICE_CASES.json", service_cases)
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", choices=("fit", "evaluate", "all"), default="all")
    parser.add_argument("--projects", nargs="+", choices=PROJECTS,
                        help="fit only completed project collections; evaluation still waits for all fits")
    args = parser.parse_args()
    if args.phase in ("fit", "all"):
        fit_projects(args.projects)
    if args.phase in ("evaluate", "all"):
        evaluate_projects()
