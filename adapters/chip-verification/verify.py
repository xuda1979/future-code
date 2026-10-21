#!/usr/bin/env python3
"""Use as an existing pinned run_check/integration check; standard library only."""
import argparse
import json
from pathlib import Path
import sys

from plan import read_json, validate
from runner import run_plan


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", required=True)
    parser.add_argument("--project", default=".")
    parser.add_argument("--output")
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()
    try:
        plan = validate(read_json(Path(args.plan).read_text()))
        if args.validate_only:
            print(json.dumps({"schema": 1, "planValid": True, "executionPerformed": False}))
            return 0
        report = run_plan(plan, args.project, args.output)
        print(json.dumps({"schema": 1, "verdict": report["verdict"], "runs": len(report["runs"]),
                          "failures": [{"case": r["case"], "seed": r["seed"], "verdict": r["verdict"],
                                        "error": r.get("error"), "failed": r.get("failed", [])[:8],
                                        "diagnostic": r.get("diagnostic", "")}
                                       for r in report["runs"] if r["verdict"] != "PASS"][:32],
                          "coverage": report["coverage"], "requirements": report["requirements"],
                          "preparation": {name: {"verdict": stage["verdict"], "commands": len(stage["steps"]),
                                                 "error": stage.get("error")}
                                          for name, stage in report["prepared"].items()},
                          "sharedArtifactsChanged": report["sharedArtifactsChanged"],
                          "inputsChanged": report["inputsChanged"], "evidenceDirectory": report["evidenceDirectory"]}))
        return {"PASS": 0, "FAIL": 1, "UNKNOWN": 2}[report["verdict"]]
    except Exception as error:
        print(json.dumps({"schema": 1, "verdict": "UNKNOWN", "error": f"{type(error).__name__}: {error}"}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
