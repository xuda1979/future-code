"""Optional project-owned verification contract; no chip policy in the kernel."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re


def require(condition, message):
    if not condition:
        raise ValueError(message)


def fields(value, required, optional=()):
    require(isinstance(value, dict) and set(required) <= value.keys()
            and not value.keys() - set(required) - set(optional), "invalid fields")


def integer(value, minimum, maximum):
    return type(value) is int and minimum <= value <= maximum


def names(value):
    return (isinstance(value, list) and 0 < len(value) <= 256
            and all(isinstance(x, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,95}", x) for x in value)
            and len(set(value)) == len(value))


def relative(value):
    require(isinstance(value, str) and value and not value.startswith("/")
            and not any(x in value for x in ("\\", "\0", ":"))
            and all(x and x not in (".", "..", ".git", ".future-code") for x in value.split("/")),
            "unsafe relative path")
    return value


def confined(root, path):
    path = (Path(root) / relative(path)).resolve()
    require(path.is_relative_to(Path(root).resolve()), "path escapes root")
    return path


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def _unique(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, "duplicate JSON key")
        value[key] = item
    return value


def read_json(text):
    def invalid(value):
        raise ValueError("nonfinite JSON")
    value = json.loads(text, object_pairs_hook=_unique, parse_constant=invalid)
    canonical(value)  # Reject overflow, including 1e999.
    return value


def evidence_kind(evidence):
    if evidence["format"] == "sby":
        return {"prove": "proof", "bmc": "bounded", "cover": "cover"}[evidence["mode"]]
    return "lint" if evidence["format"] == "exit-code" else "simulation"


def validate(plan):
    fields(plan, ["schema", "name", "inputs", "requirements", "cases", "coverage", "maxParallel",
                  "timeoutMs", "maxOutputBytes", "maxArtifactBytes"], ["envAllow"])
    require(plan["schema"] == 1 and isinstance(plan["name"], str) and 0 < len(plan["name"]) <= 128, "invalid plan identity")
    require(integer(plan["maxParallel"], 1, 8) and integer(plan["timeoutMs"], 100, 3_600_000), "invalid execution budget")
    require(integer(plan["maxOutputBytes"], 128, 16 * 1024 * 1024)
            and integer(plan["maxArtifactBytes"], 1, 64 * 1024 * 1024), "invalid artifact budget")
    require(isinstance(plan["inputs"], list) and 0 < len(plan["inputs"]) <= 256
            and len(set(plan["inputs"])) == len(plan["inputs"]), "invalid inputs")
    for path in plan["inputs"]:
        relative(path)
    env = plan.get("envAllow", [])
    require(isinstance(env, list) and len(env) <= 32 and len(set(env)) == len(env)
            and all(isinstance(x, str) and re.fullmatch(r"[A-Z_][A-Z0-9_]*", x)
                    and not x.startswith(("LD_", "DYLD_", "NODE_OPTIONS", "BUN_OPTIONS", "PYTHONPATH", "FUTURE_"))
                    and x not in ("PATH", "HOME", "TMPDIR", "TMP", "TEMP") for x in env), "unsafe environment capability")
    cases = plan["cases"]
    require(isinstance(cases, list) and 0 < len(cases) <= 64, "invalid cases")
    require(names([c["id"] for c in cases]), "duplicate case IDs")
    total = 0
    for case in cases:
        fields(case, ["id", "seeds", "steps", "evidence"], ["artifacts", "prepare"])
        seeds = case["seeds"]
        require(isinstance(seeds, list) and 0 < len(seeds) <= 256
                and all(integer(s, 0, 2**31 - 1) for s in seeds) and len(set(seeds)) == len(seeds), "invalid seeds")
        total += len(seeds)
        require(isinstance(case["steps"], list) and 0 < len(case["steps"]) <= 16, "invalid steps")
        preparation = case.get("prepare", {})
        if preparation:
            fields(preparation, ["steps", "artifacts"])
            require(isinstance(preparation["steps"], list) and 0 < len(preparation["steps"]) <= 16, "invalid preparation steps")
            require(isinstance(preparation["artifacts"], list) and 0 < len(preparation["artifacts"]) <= 16
                    and len(set(preparation["artifacts"])) == len(preparation["artifacts"]), "invalid prepared artifacts")
            for path in preparation["artifacts"]:
                relative(path)
            require(not any("{seed}" in arg or "{shared}" in arg for step in preparation["steps"] for arg in step["argv"]),
                    "shared preparation cannot depend on a seed or itself")
        elif "prepare" in case:
            require(False, "empty preparation is invalid")
        for step in preparation.get("steps", []) + case["steps"]:
            fields(step, ["argv", "timeoutMs"])
            argv = step["argv"]
            require(isinstance(argv, list) and 0 < len(argv) <= 256
                    and all(isinstance(x, str) and x and "\0" not in x for x in argv)
                    and Path(argv[0]).is_absolute() and "{" not in argv[0], "executable must be absolute")
            require(integer(step["timeoutMs"], 10, plan["timeoutMs"]), "invalid step deadline")
        require(preparation or not any("{shared}" in arg for step in case["steps"] for arg in step["argv"]),
                "shared artifact requested without preparation")
        evidence = case["evidence"]
        fmt = evidence.get("format")
        require(fmt in ("checks-json", "junit", "uvm", "sby", "exit-code"), "unknown evidence format")
        if fmt == "exit-code":
            fields(evidence, ["format"])
        else:
            relative(evidence["path"])
            if fmt == "checks-json":
                fields(evidence, ["format", "path", "checks"])
                require(names(evidence["checks"]), "invalid expected checks")
            elif fmt == "junit":
                fields(evidence, ["format", "path", "minimumTests"])
                require(integer(evidence["minimumTests"], 1, 1_000_000), "invalid minimum test count")
            elif fmt == "sby":
                fields(evidence, ["format", "path", "mode", "config", "assumptions"], ["depth"])
                require(evidence["mode"] in ("prove", "bmc", "cover"), "invalid formal mode")
                require(relative(evidence["config"]) in plan["inputs"], "formal configuration must be an identified input")
                require(isinstance(evidence["assumptions"], list)
                        and all(isinstance(x, str) and x.strip() for x in evidence["assumptions"]), "invalid formal assumptions")
                require(evidence["mode"] != "bmc" or integer(evidence.get("depth"), 1, 1_000_000), "BMC requires explicit depth")
            else:
                fields(evidence, ["format", "path", "testName"])
                require(isinstance(evidence["testName"], str)
                        and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_:]{0,95}", evidence["testName"]), "invalid UVM test name")
        artifacts = case.get("artifacts", [])
        require(isinstance(artifacts, list) and len(artifacts) <= 16 and len(set(artifacts)) == len(artifacts), "invalid artifacts")
        for path in artifacts:
            relative(path)
    require(total <= 1024, "seed matrix exceeds budget")
    requirements = plan["requirements"]
    require(isinstance(requirements, list) and names([r["id"] for r in requirements]), "invalid requirement IDs")
    by_id = {c["id"]: c for c in cases}
    referenced = set()
    for row in requirements:
        fields(row, ["id", "description", "evidence", "cases"])
        require(isinstance(row["description"], str) and row["description"].strip(), "missing requirement description")
        require(names(row["cases"]) and all(c in by_id for c in row["cases"]), "unmapped requirement")
        require(all(evidence_kind(by_id[c]["evidence"]) == row["evidence"] for c in row["cases"]),
                "evidence strength mismatch: simulation, BMC and cover cannot prove a property")
        referenced.update(row["cases"])
    require(referenced == by_id.keys(), "untraced verification case")
    goals = plan["coverage"]
    require(isinstance(goals, list) and len(goals) <= 64, "invalid coverage goals")
    require(not goals or names([g["id"] for g in goals]), "duplicate coverage goal")
    for goal in goals:
        fields(goal, ["id", "case", "bins", "minimum"])
        require(goal["case"] in by_id and by_id[goal["case"]]["evidence"]["format"] == "checks-json", "coverage requires raw bin counts")
        require(names(goal["bins"]) and type(goal["minimum"]) in (int, float)
                and 0 < goal["minimum"] <= 1, "invalid coverage threshold")
    return plan


def validate_formal_configs(plan, project):
    """Initial support is deliberately single-task SBY, with no mode relabeling."""
    for case in plan["cases"]:
        evidence = case["evidence"]
        if evidence["format"] != "sby":
            continue
        section, options = None, {}
        for line in confined(project, evidence["config"]).read_text().splitlines():
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            if line.startswith("["):
                require(line != "[tasks]", "multi-task SBY requires a separate reviewed adapter")
                section = line
            elif section == "[options]":
                pair = line.split()
                require(len(pair) == 2 and pair[0] not in options, "ambiguous SBY options")
                options[pair[0]] = pair[1]
        require(options.get("mode") == evidence["mode"], "SBY configuration mode differs from evidence contract")
        if evidence["mode"] == "bmc":
            require(options.get("depth") == str(evidence["depth"]), "SBY depth differs from evidence contract")
        expected = "{project}/" + evidence["config"]
        require(any(expected in step["argv"] for step in case["steps"]), "SBY command must use the declared configuration")
