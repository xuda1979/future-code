#!/usr/bin/env python3
"""Generate a real RTL regression and a normal, project-neutral Swarm config."""
import argparse
import json
from pathlib import Path
import shutil
import sys

REPO = Path(__file__).resolve().parents[2]


def make_plan(project, iverilog, vvp, *, negative=False, ivl_root=None, verilator=None, share_build=True):
    base = "examples/chip-verification/"
    rtl = base + "rtl/" + ("fifo_bug.sv" if negative else "fifo.sv")
    bench = base + "tb.sv"
    compile_args = [str(iverilog)] + (["-B", str(ivl_root)] if ivl_root else [])
    runtime_args = [str(vvp)] + (["-M", str(ivl_root)] if ivl_root else [])
    plan = {"schema": 1, "name": "fifo-negative-control" if negative else "fifo-regression",
            "inputs": [rtl, bench], "maxParallel": 3, "timeoutMs": 60000,
            "maxOutputBytes": 262144, "maxArtifactBytes": 4194304,
            "requirements": [{"id": "fifo-behavior", "description": "FIFO order, flags, overflow, underflow, wrap and synchronous reset",
                              "evidence": "simulation", "cases": ["fifo"]}],
            "cases": [{"id": "fifo", "seeds": [1, 17, 101], "steps": [
                {"argv": compile_args + ["-g2012", "-s", "tb", "-o", "{work}/sim.vvp", "{project}/" + rtl, "{project}/" + bench], "timeoutMs": 15000},
                {"argv": runtime_args + ["{work}/sim.vvp", "+seed={seed}"], "timeoutMs": 10000}],
                "evidence": {"format": "checks-json", "path": "results.json", "checks": ["scoreboard", "reset"]},
                "artifacts": ["trace.vcd"]}],
            "coverage": [{"id": "fifo-functional-bins", "case": "fifo", "bins": ["empty", "full", "simultaneous", "overflow", "underflow", "reset"], "minimum": 1.0}]}
    if share_build:
        case = plan["cases"][0]
        case["prepare"] = {"steps": [case["steps"].pop(0)], "artifacts": ["sim.vvp"]}
        case["steps"][0]["argv"] = [arg.replace("{work}/sim.vvp", "{shared}/sim.vvp") for arg in case["steps"][0]["argv"]]
    if verilator:
        plan["cases"].append({"id": "rtl-lint", "seeds": [0], "steps": [
            {"argv": [str(verilator), "--lint-only", "--top-module", "fifo", "{project}/" + rtl], "timeoutMs": 15000}],
            "evidence": {"format": "exit-code"}})
        plan["requirements"].append({"id": "lint", "description": "Verilator RTL lint with default fatal diagnostics", "evidence": "lint", "cases": ["rtl-lint"]})
        plan["envAllow"] = ["VERILATOR_ROOT"]
    return plan


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--iverilog", default=shutil.which("iverilog"))
    parser.add_argument("--vvp", default=shutil.which("vvp"))
    parser.add_argument("--ivl-root")
    parser.add_argument("--verilator")
    parser.add_argument("--negative-control", action="store_true")
    parser.add_argument("--per-seed-build", action="store_true", help="Comparison baseline: compile separately for every seed")
    args = parser.parse_args()
    if not args.iverilog or not args.vvp:
        parser.error("Icarus Verilog is required; install iverilog or provide --iverilog and --vvp")
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    plan = make_plan(REPO, Path(args.iverilog).resolve(), Path(args.vvp).resolve(),
                     negative=args.negative_control, ivl_root=args.ivl_root, verilator=args.verilator, share_build=not args.per_seed_build)
    path = output / "plan.json"
    path.write_text(json.dumps(plan, indent=2) + "\n")
    # This is a new configuration using the ordinary Swarm schema and budgets.
    swarm = json.loads((REPO / "examples/swarm/spec.json").read_text())
    swarm.update(name="chip-verification", project=str(REPO))
    adapter = REPO / "adapters/chip-verification"
    files = [str(adapter / name) for name in ("verify.py", "plan.py", "runner.py", "evidence.py")]
    files += [str(REPO / "src/harness/foundry/prepared_commands.py")]
    files += [str(path), str(REPO / "examples/chip-verification/tb.sv")]
    files += list({step["argv"][0] for case in plan["cases"] for step in case.get("prepare", {}).get("steps", []) + case["steps"]})
    if args.ivl_root:
        files += [str(p) for p in Path(args.ivl_root).rglob("*") if p.is_file()]
    swarm["checks"] = {"chip": {"argv": [sys.executable, str(adapter / "verify.py"), "--plan", str(path)],
                                "files": files, "envAllow": plan.get("envAllow", []), "replaySafe": True}}
    swarm["integrationChecks"] = ["chip"]
    swarm["agents"]["coder"]["checks"] = ["chip"]
    swarm["agents"]["coder"]["system"] = (
        "Implement the scoped RTL task. Read the frozen specification and testbench. Use run_check chip to reproduce failures. "
        "Treat missing evidence and coverage holes as unresolved. Keep passing requirements and report paths/seeds for failures. "
        "Do not edit tests, protocols, tools or thresholds. Independent verification determines acceptance.")
    swarm["protectedPaths"] += ["adapters/chip-verification", "examples/chip-verification/tb.sv", "examples/chip-verification/configure.py"]
    if output.is_relative_to(REPO):
        swarm["protectedPaths"].append(str(output.relative_to(REPO)))
    swarm["budget"]["toolTimeoutMs"] = 90000
    (output / "swarm.json").write_text(json.dumps(swarm, indent=2) + "\n")
    rtl = "examples/chip-verification/rtl/" + ("fifo_bug.sv" if args.negative_control else "fifo.sv")
    tasks = [{"id": "fifo-verification", "goal": "Verify and repair the FIFO against the pinned queue contract; preserve all other behavior.",
              "acceptance": ["All frozen lint/simulation/coverage checks and independent integration pass"],
              "dependencies": [], "writeScope": [rtl], "readScope": ["examples/chip-verification"],
              "input": {"contract": "Depth 4, 8-bit data, synchronous active-low reset. Accept push iff not full and pop iff not empty using pre-edge flags. Preserve FIFO order."}}]
    (output / "tasks.json").write_text(json.dumps(tasks, indent=2) + "\n")
    print(json.dumps({"plan": str(path), "swarm": str(output / "swarm.json"), "tasks": str(output / "tasks.json")}))


if __name__ == "__main__":
    main()
