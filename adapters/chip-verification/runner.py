"""Chip evidence interpretation over a project-neutral prepared-command engine."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import importlib.util
import os
from pathlib import Path
import tempfile
import time

from evidence import parse
from plan import canonical, confined, digest, evidence_kind, require, validate, validate_formal_configs

CORE = Path(__file__).resolve().parents[2] / "src/harness/foundry/prepared_commands.py"
_module = importlib.util.spec_from_file_location("future_prepared_commands", CORE)
_commands = importlib.util.module_from_spec(_module)
_module.loader.exec_module(_commands)
file_identity = _commands.file_identity


def run_plan(plan, project, output=None):
    validate(plan)
    require(os.name == "posix", "local chip verification requires POSIX (Linux/macOS/WSL)")
    project = Path(project).resolve()
    validate_formal_configs(plan, project)
    if output is not None:
        Path(output).mkdir(parents=True, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix="chip-verification-", dir=output)).resolve()
    inputs = {name: file_identity(confined(project, name)) for name in plan["inputs"]}
    implementation_paths = {name: Path(__file__).parent / name
                            for name in ("verify.py", "runner.py", "plan.py", "evidence.py")}
    implementation_paths["prepared_commands.py"] = CORE
    implementation = {name: file_identity(path) for name, path in implementation_paths.items()}
    tools = {step["argv"][0]: file_identity(Path(step["argv"][0]).resolve())
             for case in plan["cases"] for step in case.get("prepare", {}).get("steps", []) + case["steps"]}
    deadline = time.monotonic() + plan["timeoutMs"] / 1000
    prepared = {}
    for case in plan["cases"]:
        if "prepare" not in case:
            continue
        env = {"PATH": os.environ.get("PATH", ""), "LANG": "C.UTF-8"}
        env.update({name: os.environ[name] for name in plan.get("envAllow", []) if name in os.environ})
        prepared[case["id"]] = _commands.prepare_stage(case["prepare"], directory / (case["id"] + "-prepare"),
            env, {"project": project}, deadline, plan["maxOutputBytes"], plan["maxArtifactBytes"])

    def run(case, seed):
        work = directory / f"{case['id']}-{seed}"
        work.mkdir()
        row = {"case": case["id"], "seed": seed, "kind": evidence_kind(case["evidence"]),
               "verdict": "UNKNOWN", "steps": [], "artifacts": {}, "bins": {}, "directory": str(work)}
        env = {"PATH": os.environ.get("PATH", ""), "HOME": str(work), "TMPDIR": str(work),
               "LANG": "C.UTF-8", "FUTURE_VERIFY_SEED": str(seed)}
        env.update({name: os.environ[name] for name in plan.get("envAllow", []) if name in os.environ})
        try:
            bindings = {"project": project, "work": work, "seed": seed}
            if case["id"] in prepared:
                stage = prepared[case["id"]]
                row["preparation"] = case["id"]
                if stage["verdict"] != "PASS":
                    row.update(verdict=stage["verdict"], error="PREPARATION_FAILED", diagnostic=stage.get("diagnostic", stage.get("error", "")))
                    return row
                bindings["shared"] = stage["published"]
            row.update(_commands.run_steps(case["steps"], work, env, bindings, deadline, plan["maxOutputBytes"]))
            if row["verdict"] != "PASS":
                return row
            evidence = case["evidence"]
            raw = ""
            if evidence["format"] != "exit-code":
                path = confined(work, evidence["path"])
                row["artifacts"][evidence["path"]] = file_identity(path, plan["maxArtifactBytes"])
                raw = path.read_text()
                require(file_identity(path, plan["maxArtifactBytes"]) == row["artifacts"][evidence["path"]], "evidence changed while reading")
            row.update(parse(evidence, raw, seed))
            for name in case.get("artifacts", []):
                row["artifacts"][name] = file_identity(confined(work, name), plan["maxArtifactBytes"])
            require(sum(meta["bytes"] for meta in row["artifacts"].values())
                    <= plan["maxArtifactBytes"] + plan["maxOutputBytes"], "combined artifacts exceed budget")
        except Exception as error:
            row.update(verdict="UNKNOWN", error=f"{type(error).__name__}: {error}")
            if row["steps"]:
                row["diagnostic"] = (work / row["steps"][-1]["log"]).read_text(errors="replace")[-2048:]
        return row

    matrix = [(case, seed) for case in plan["cases"] for seed in case["seeds"]]
    with ThreadPoolExecutor(max_workers=plan["maxParallel"]) as pool:
        futures = [pool.submit(run, case, seed) for case, seed in matrix]
        runs = [future.result() for future in futures]
    goals = []
    for goal in plan["coverage"]:
        selected = [r for r in runs if r["case"] == goal["case"]]
        complete = all(r["verdict"] == "PASS" and set(goal["bins"]) <= r["bins"].keys() for r in selected)
        bins = {name: sum(r["bins"].get(name, 0) for r in selected) for name in goal["bins"]}
        holes = [name for name, count in bins.items() if count == 0]
        fraction = (len(bins) - len(holes)) / len(bins) if complete else None
        goals.append({"id": goal["id"], "verdict": "UNKNOWN" if not complete else "PASS" if fraction >= goal["minimum"] else "FAIL",
                      "fraction": fraction, "minimum": goal["minimum"], "bins": bins, "uncoveredBins": holes})
    requirements = [{"id": req["id"], "evidence": req["evidence"],
                     "verdict": _verdict([r["verdict"] for r in runs if r["case"] in req["cases"]])}
                    for req in plan["requirements"]]
    changed = False
    try:
        changed = inputs != {name: file_identity(confined(project, name)) for name in inputs}
        changed |= tools != {name: file_identity(Path(name).resolve()) for name in tools}
        changed |= implementation != {name: file_identity(path) for name, path in implementation_paths.items()}
    except (OSError, ValueError):
        changed = True
    shared_changed = any(stage["verdict"] == "PASS" and not _commands.prepared_unchanged(stage, plan["maxArtifactBytes"])
                         for stage in prepared.values())
    verdict = "UNKNOWN" if changed or shared_changed else _verdict([r["verdict"] for r in runs + goals + requirements])
    report = {"schema": 1, "name": plan["name"], "planHash": digest(plan), "inputs": inputs, "tools": tools,
              "implementation": implementation,
              "prepared": prepared, "sharedArtifactsChanged": shared_changed,
              "verdict": verdict, "inputsChanged": changed, "runs": runs, "coverage": goals, "requirements": requirements,
              "evidenceDirectory": str(directory), "scope": "Declared RTL/tool contract only; no whole-chip or physical signoff claim"}
    (directory / "plan.json").write_bytes(canonical(plan))
    (directory / "report.json").write_bytes(canonical(report))
    return report


def _verdict(values):
    return "FAIL" if "FAIL" in values else "UNKNOWN" if not values or "UNKNOWN" in values else "PASS"
