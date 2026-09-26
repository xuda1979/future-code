#!/usr/bin/env python3
"""Cheap, dependency-free checks; not a linter, type checker or security audit."""
from __future__ import annotations

import ast
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from future_code.contracts import Config, TaskSpec
from future_code.quality import validate_experiment, validate_research


def main() -> int:
    count = 0
    for tree in ("src", "tests", "scripts", "examples"):
        for path in sorted((ROOT / tree).rglob("*.py")):
            data = path.read_text(encoding="utf-8")
            parsed = ast.parse(data, filename=str(path), feature_version=(3, 11))
            compile(parsed, str(path), "exec")
            for node in ast.walk(parsed):
                if isinstance(node, ast.ClassDef):
                    fields = [child.target.id for child in node.body
                              if isinstance(child, ast.AnnAssign) and isinstance(child.target, ast.Name)]
                    if len(fields) != len(set(fields)):
                        raise ValueError(f"Duplicate annotated field in {path.name}:{node.name}")
            count += 1
    for name in ("http-config.json", "command-config.json"):
        Config.from_dict(json.loads((ROOT / "examples" / name).read_text()))
    config = Config.from_dict(json.loads((ROOT / "examples/http-config.json").read_text()))
    for task in json.loads((ROOT / "examples/tasks.json").read_text())["tasks"]:
        config.validate_task(TaskSpec.from_dict(task))
    validate_experiment(json.loads((ROOT / "examples/experiment.json").read_text()), ROOT / "examples")
    validate_research(json.loads((ROOT / "examples/research_evidence.json").read_text()), ROOT / "examples")
    print(json.dumps({"verdict": "PASS", "python_files": count,
                      "checks": ["Python 3.11 grammar", "current-interpreter compilation", "duplicate annotated fields", "example configuration/task contracts", "synthetic domain manifest contracts"],
                      "not_run": ["Python 3.11 interpreter execution", "third-party lint", "static type checker", "vulnerability audit"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
