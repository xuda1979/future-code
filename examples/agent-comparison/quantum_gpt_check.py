#!/usr/bin/env python3
"""Independent check outside agent worktree. 0=PASS, 1=known RED, 3=invalid test."""
import importlib.util
import json
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path

def source_module(path):
    spec = importlib.util.spec_from_file_location("benchmark_target", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def compare_runs(repo):
    module = source_module(repo / "evals/runner/compare_runs.py")
    results = [{"domain": "quantum", "passed": "false"}, {"domain": "quantum", "passed": False}]
    assert module.summarize_results(results, "domain") == [
        {"name": "quantum", "passed": 0, "total": 2, "rate": 0.0}
    ], "non-boolean success inflated count"
    with tempfile.TemporaryDirectory() as d:
        p = Path(d)
        (p / "manifest.json").write_text(json.dumps({"prompt_style": "direct"}))
        (p / "scorecard.json").write_text(json.dumps({"results": [
            {"id": "n1", "passed": "false", "domain": "quantum", "category": "repair"},
            {"id": "n2", "passed": False, "domain": "quantum", "category": "repair"}
        ]}))
        assert "overall: 0/2 (0.0%)" in module.render_run_summary(p), "non-boolean success inflated overall"

def holdout_manifest(repo):
    script = repo / "scripts/verify_holdout_dataset.py"
    with tempfile.TemporaryDirectory() as d:
        p = Path(d)
        row = lambda i, task, fam: {"example_id": i, "metadata": {"task_id": task, "prompt_family": fam, "domain": "quantum"}}
        (p / "train.jsonl").write_text(json.dumps(row("a", "q1", "f1")) + "\n")
        (p / "eval.jsonl").write_text(json.dumps(row("b", "q2", "f2")) + "\n")
        manifest = {"train_summary": {"count": 999, "tasks": {"q1": 1}, "prompt_families": {"f1": 1}, "domains": {"quantum": 1}},
                    "eval_summary": {"count": 1, "tasks": {"q2": 1}, "prompt_families": {"f2": 1}, "domains": {"quantum": 1}},
                    "holdout_policy": {"train_eval_example_id_overlap": False, "train_eval_task_id_overlap": False,
                                       "train_eval_prompt_family_overlap": False}}
        (p / "manifest.json").write_text(json.dumps(manifest))
        result = subprocess.run([sys.executable, str(script), "--train-file", str(p / "train.jsonl"),
            "--eval-file", str(p / "eval.jsonl"), "--manifest", str(p / "manifest.json")],
            capture_output=True, text=True, timeout=15)
        assert result.returncode in (0, 1), f"script error: {result.stderr}"
        report = json.loads(result.stdout)
        assert report.get("train_matches_manifest_count") is False, "fixture must mismatch"
        assert result.returncode == 1 and report.get("ok") is False, "manifest mismatch accepted"

def candidate_completeness(repo):
    source = repo / "evals/runner"
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        runner = root / "evals/runner"
        runner.mkdir(parents=True)
        for name in ("run_eval.py", "task_metadata.py"):
            (runner / name).write_bytes((source / name).read_bytes())
        task = root / "evals/tasks/software/missing"
        task.mkdir(parents=True)
        (task / "task.json").write_text(json.dumps({"id": "missing", "name": "missing candidate",
          "domain": "software", "category": "repair", "candidate_file": "candidate.py"}))
        (task / "candidate.py").write_text("def answer():\n    return 5\n")
        (task / "tests.py").write_text('def run_tests(p):\n    return {"passed": "return 5" in open(p).read(), "details": []}\n')
        work = root / "evals/runs/a"
        work.mkdir(parents=True)
        mapping = work / "candidate-map.json"
        mapping.write_text("{}")
        command = [sys.executable, str(runner / "run_eval.py"), "--candidate-map", str(mapping)]
        missing = subprocess.run(command, capture_output=True, text=True, timeout=15)
        if missing.returncode == 0:
            scores = json.loads((work / "scorecard.json").read_text())["results"]
            assert scores and all(s.get("source") != "reference" and s.get("passed") is False for s in scores), "missing candidate used reference"
        else:
            assert "candidate" in (missing.stderr + missing.stdout).lower(), "error must identify missing candidate"
        produced = root / "generated.py"
        produced.write_text("def answer():\n    return 5\n")
        mapping.write_text(json.dumps({"missing": str(produced)}))
        complete = subprocess.run(command, capture_output=True, text=True, timeout=15)
        assert complete.returncode == 0, f"complete candidate run broken: {complete.stderr}"
        results = json.loads((work / "scorecard.json").read_text())["results"]
        assert results and results[0]["passed"] is True and results[0]["source"] == "override"

CASES = {"compare-runs": compare_runs, "holdout-manifest": holdout_manifest,
         "candidate-completeness": candidate_completeness}
def main():
    if len(sys.argv) != 2 or sys.argv[1] not in CASES:
        print("usage: quantum_gpt_check.py " + "|".join(CASES), file=sys.stderr)
        return 3
    name = sys.argv[1]
    try:
        CASES[name](Path.cwd())
    except AssertionError as error:
        print(f"RED_CONTROL_{name}: {error}", file=sys.stderr)
        return 1
    except Exception:
        traceback.print_exc()
        return 3
    print(f"PASS_{name}")
    return 0
if __name__ == "__main__":
    raise SystemExit(main())
