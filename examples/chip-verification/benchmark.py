#!/usr/bin/env python3
"""Matched real RTL comparison; no live-LLM or industrial productivity claim."""
import argparse
import json
from pathlib import Path
import shutil
import statistics
import sys
import time

from configure import REPO, make_plan
sys.path.insert(0, str(REPO / "adapters/chip-verification"))
from runner import run_plan
from plan import require


def benchmark(output, iverilog, vvp, ivl_root=None, repetitions=3, seed_count=12):
    require(type(repetitions) is int and 1 <= repetitions <= 20
            and type(seed_count) is int and 2 <= seed_count <= 256, "invalid benchmark budget")
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    seeds = ([1, 17, 101] + [n for n in range(2, 260) if n not in (17, 101)])[:seed_count]
    trials = []
    for trial in range(repetitions):
        observations, measurements = {}, {}
        order = [False, True] if trial % 2 == 0 else [True, False]
        for shared in order:
            arm = "shared-build" if shared else "per-seed-build"
            plan = make_plan(REPO, iverilog, vvp, ivl_root=ivl_root, share_build=shared)
            plan["cases"][0]["seeds"] = seeds
            start = time.monotonic()
            report = run_plan(plan, REPO, output)
            elapsed = (time.monotonic() - start) * 1000
            require(report["verdict"] == "PASS" and len(report["runs"]) == seed_count,
                    "benchmark requires complete independently checked execution")
            builds = sum(len(stage["steps"]) for stage in report["prepared"].values())
            builds += sum(max(0, len(row["steps"]) - 1) for row in report["runs"])
            require(builds == (1 if shared else seed_count), "unexpected compilation count")
            observations[arm] = {"inputs": report["inputs"], "tools": report["tools"], "implementation": report["implementation"],
                                 "runs": [(row["seed"], row["verdict"], row["bins"]) for row in report["runs"]],
                                 "coverage": report["coverage"], "requirements": report["requirements"]}
            measurements[arm] = {"wallMs": elapsed, "compilations": builds, "executedSimulations": seed_count,
                                 "commands": builds + seed_count, "verdict": report["verdict"],
                                 "evidenceDirectory": report["evidenceDirectory"]}
        require(observations["shared-build"] == observations["per-seed-build"], "matched arms changed evidence or inputs")
        trials.append({"trial": trial, "order": ["shared-build" if s else "per-seed-build" for s in order], "arms": measurements})
    medians = {name: statistics.median(trial["arms"][name]["wallMs"] for trial in trials)
               for name in ("per-seed-build", "shared-build")}
    record = {"schema": 1, "seeds": seeds, "repetitions": repetitions, "allEvidenceEqual": True,
              "compilationsPerRegression": {"per-seed-build": seed_count, "shared-build": 1},
              "avoidedCompilationFraction": (seed_count - 1) / seed_count,
              "medianWallMs": medians, "trials": trials,
              "inputs": observations["shared-build"]["inputs"], "tools": observations["shared-build"]["tools"],
              "implementation": observations["shared-build"]["implementation"],
              "scope": "Measured small real RTL workload; no live-LLM or industrial speedup claim"}
    path = output / "comparison.json"
    path.write_text(json.dumps(record, indent=2) + "\n")
    return path, record


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--iverilog", default=shutil.which("iverilog"))
    parser.add_argument("--vvp", default=shutil.which("vvp"))
    parser.add_argument("--ivl-root")
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--seeds", type=int, default=12)
    args = parser.parse_args()
    if not args.iverilog or not args.vvp:
        parser.error("Icarus Verilog is required")
    path, record = benchmark(args.output, str(Path(args.iverilog).resolve()), str(Path(args.vvp).resolve()),
                             args.ivl_root, args.repetitions, args.seeds)
    print(json.dumps({"report": str(path), "allEvidenceEqual": record["allEvidenceEqual"],
                      "compilationsPerRegression": record["compilationsPerRegression"], "medianWallMs": record["medianWallMs"]}))
