"""Executable gates and domain-specific evidence validation."""
from __future__ import annotations

from dataclasses import asdict
import json
from pathlib import Path
import re
import sys
from typing import Any

from .contracts import Config, ContractError, finite_number
from .process import run_process
from .security import Redactor, atomic_write
from .store import Store, encode
from .workspace import Workspace, digest, safe_path

SHA = re.compile(r"^[0-9a-f]{64}$")


def require_hash(value: Any, name: str) -> None:
    if not isinstance(value, str) or not SHA.fullmatch(value):
        raise ContractError(f"{name} requires a lowercase SHA-256 value")


def verify_files(root: Path, entries: Any) -> None:
    if not isinstance(entries, list) or not entries or len(entries) > 100:
        raise ContractError("At least one and at most 100 evidence files are required")
    seen = set()
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {"path", "sha256"}:
            raise ContractError("Evidence entries require path and sha256")
        path = safe_path(root, entry["path"])
        if entry["path"] in seen:
            raise ContractError("Duplicate evidence file")
        seen.add(entry["path"])
        require_hash(entry["sha256"], "evidence hash")
        if not path.is_file() or digest(path.read_bytes()) != entry["sha256"]:
            raise ContractError("Evidence file missing or checksum mismatch")


def validate_experiment(data: dict, root: Path) -> dict:
    required = {"schema_version", "experiment_id", "code_sha256", "config_sha256", "model_sha256",
                "dataset_manifest_sha256", "seed", "train_ids", "eval_ids", "primary", "guardrails", "evidence_files", "runtime"}
    if not isinstance(data, dict) or set(data) != required or data["schema_version"] != 1:
        raise ContractError("Experiment manifest fields or schema_version are invalid")
    from .contracts import identifier
    identifier(data["experiment_id"], "experiment id")
    for name in ("code_sha256", "config_sha256", "model_sha256", "dataset_manifest_sha256"):
        require_hash(data[name], name)
    if type(data["seed"]) is not int:
        raise ContractError("Experiment seed must be an integer")
    splits = []
    for name in ("train_ids", "eval_ids"):
        ids = data[name]
        if not isinstance(ids, list) or not ids or not all(isinstance(v, str) and v for v in ids) or len(ids) != len(set(ids)):
            raise ContractError("Split IDs must be nonempty, unique strings")
        splits.append(set(ids))
    if splits[0] & splits[1]:
        raise ContractError("Train/evaluation overlap detected")
    if not isinstance(data["runtime"], dict) or not all(data["runtime"].get(k) for k in ("python", "framework", "device")):
        raise ContractError("Runtime provenance is missing")
    primary = data["primary"]
    if not isinstance(primary, dict) or set(primary) != {"name", "value", "baseline", "direction", "min_improvement", "samples"}:
        raise ContractError("Primary metric contract is invalid")
    # Negative metrics are legitimate; finite_number's default lower bound is not used here.
    value = finite_number(primary["value"], "primary value", -1e300)
    baseline = finite_number(primary["baseline"], "baseline", -1e300)
    delta = finite_number(primary["min_improvement"], "minimum improvement")
    if primary["direction"] not in {"maximize", "minimize"}:
        raise ContractError("Metric direction must be maximize or minimize")
    if type(primary["samples"]) is not int or primary["samples"] != len(splits[1]):
        raise ContractError("Evaluation sample count must reconcile with evaluation IDs")
    if not isinstance(data["guardrails"], list) or not data["guardrails"]:
        raise ContractError("At least one declared guardrail is required")
    passed = (value - baseline if primary["direction"] == "maximize" else baseline - value) >= delta
    for guard in data["guardrails"]:
        if not isinstance(guard, dict) or set(guard) != {"name", "value", "operator", "threshold"}:
            raise ContractError("Invalid guardrail")
        v = finite_number(guard["value"], "guardrail value", -1e300)
        threshold = finite_number(guard["threshold"], "guardrail threshold", -1e300)
        if guard["operator"] not in {">=", "<="}:
            raise ContractError("Guardrail operator must be >= or <=")
        passed = passed and (v >= threshold if guard["operator"] == ">=" else v <= threshold)
    verify_files(root, data["evidence_files"])
    if not passed:
        raise ContractError("Primary improvement criterion or a guardrail failed")
    return {"verdict": "PASS", "scope": "manifest consistency, split IDs, hashes and declared thresholds only",
            "unknown": "Authenticity of training and metrics needs the configured independent executable evaluation gate"}


def validate_research(data: dict, root: Path) -> dict:
    if not isinstance(data, dict) or set(data) != {"claims", "evidence_files", "limitations"}:
        raise ContractError("Research manifest requires claims, evidence_files and limitations")
    verify_files(root, data["evidence_files"])
    paths = {v["path"] for v in data["evidence_files"]}
    if not isinstance(data["claims"], list) or not data["claims"]:
        raise ContractError("Research claims are missing")
    for claim in data["claims"]:
        if not isinstance(claim, dict) or set(claim) != {"text", "source", "evidence_path", "status"}:
            raise ContractError("Claim fields are invalid")
        if claim["status"] not in {"observed", "inference", "unknown"} or claim["evidence_path"] not in paths:
            raise ContractError("Research claim has no authenticated evidence path")
        if not all(isinstance(claim[k], str) and claim[k].strip() for k in ("text", "source")):
            raise ContractError("Research claim text and source are required")
    if not isinstance(data["limitations"], list) or not all(isinstance(x, str) for x in data["limitations"]):
        raise ContractError("Research limitations must be a list of strings")
    return {"verdict": "PASS", "scope": "source/evidence linkage only; factual claims and proofs are not automatically certified"}


async def run_gate(name: str, workspace: Workspace, db: Store, config: Config, redactor: Redactor) -> dict:
    if name not in config.gates:
        raise ContractError("Model requested an unconfigured gate")
    spec = config.gates[name]
    argv = [sys.executable if a == "$PYTHON" else a for a in spec.argv]
    fingerprint = workspace.fingerprint()
    config_hash = digest(encode({"name": name, **asdict(spec)}).encode())
    try:
        result = await run_process(argv, workspace.path, timeout=spec.timeout_seconds)
        details = redactor.value(asdict(result))
        after = workspace.fingerprint()
        passed = result.returncode == 0 and not result.timed_out and not result.output_truncated and fingerprint == after
        if fingerprint != after:
            details["reason"] = "Gate modified authenticated source files; verdict invalidated"
    except (OSError, ContractError) as e:
        passed = False
        details = {"error": redactor.text(f"{type(e).__name__}: {e}")}
    verdict = "PASS" if passed else "FAIL"
    details.update({"gate": name, "config_sha256": config_hash, "fingerprint": fingerprint})
    evidence_id = db.add_evidence(workspace.task.id, workspace.attempt_id, name, verdict, fingerprint, "", details)
    relative = f"artifacts/{workspace.attempt_id}/{evidence_id}.json"
    atomic_write(safe_path(workspace.control, relative), json.dumps(details, sort_keys=True, indent=2).encode())
    db.conn.execute("UPDATE evidence SET path=? WHERE id=?", (relative, evidence_id))
    return {"id": evidence_id, "gate": name, "verdict": verdict, "fingerprint": fingerprint,
            "detail": details, "path": relative}
