"""Offline protocol adversaries plus optional real EDA integration (no model API)."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
ADAPTER = REPO / "adapters/chip-verification"
sys.path.insert(0, str(ADAPTER))
from evidence import parse
from plan import read_json, validate, validate_formal_configs
from runner import run_plan, _commands

spec = importlib.util.spec_from_file_location("chip_configure", REPO / "examples/chip-verification/configure.py")
configure = importlib.util.module_from_spec(spec)
spec.loader.exec_module(configure)


def base_plan():
    return {"schema": 1, "name": "protocol-test", "inputs": ["producer.py"],
            "maxParallel": 2, "timeoutMs": 3000, "maxOutputBytes": 4096, "maxArtifactBytes": 16384,
            "requirements": [{"id": "behavior", "description": "Declared fixture behavior", "evidence": "simulation", "cases": ["trial"]}],
            "cases": [{"id": "trial", "seeds": [1, 17], "steps": [
                {"argv": [sys.executable, "{project}/producer.py", "{seed}"], "timeoutMs": 1500}],
                "evidence": {"format": "checks-json", "path": "result.json", "checks": ["order"]}}],
            "coverage": [{"id": "edges", "case": "trial", "bins": ["empty", "full"], "minimum": 1.0}]}


PRODUCER = '''import json,sys
from pathlib import Path
seed=int(sys.argv[1])
Path("result.json").write_text(json.dumps({"schema":1,"seed":seed,
"checks":[{"id":"order","passed":True}],"bins":{"empty":int(seed==1),"full":int(seed==17)}}))
'''


class ProtocolTests(unittest.TestCase):
    def test_duplicate_nonfinite_json(self):
        for raw in ('{"x":1,"x":2}', '{"x":NaN}', '{"x":1e999}'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                read_json(raw)

    def test_plan_rejects_unbounded_or_ambiguous_authority(self):
        changes = [lambda p: p.update(maxParallel=9), lambda p: p.update(timeoutMs=0),
                   lambda p: p["cases"][0].update(seeds=[1, 1]),
                   lambda p: p["cases"][0]["steps"][0].update(argv=["python3"]),
                   lambda p: p["cases"][0]["evidence"].update(path="../stale.json"),
                   lambda p: p["requirements"][0].update(cases=["missing"]),
                   lambda p: p["requirements"][0].update(evidence="proof"),
                   lambda p: p["coverage"][0].update(minimum=0),
                   lambda p: p.update(envAllow=["PYTHONPATH"]),
                   lambda p: p.update(inputs=["../source"])]
        validate(base_plan())
        for change in changes:
            p = base_plan()
            change(p)
            with self.subTest(plan=p), self.assertRaises((ValueError, KeyError)):
                validate(p)

    def test_checks_bind_every_declared_check_and_seed(self):
        evidence = base_plan()["cases"][0]["evidence"]
        good = {"schema": 1, "seed": 1, "checks": [{"id": "order", "passed": True}], "bins": {"empty": 1}}
        self.assertEqual(parse(evidence, json.dumps(good), 1)["verdict"], "PASS")
        for changed in [dict(good, seed=17), dict(good, checks=[]), dict(good, checks=good["checks"] * 2),
                        dict(good, checks=[{"id": "order", "passed": 1}]), dict(good, bins={"empty": -1})]:
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                parse(evidence, json.dumps(changed), 1)
        good["checks"][0]["passed"] = False
        self.assertEqual(parse(evidence, json.dumps(good), 1)["verdict"], "FAIL")

    def test_junit_failed_skipped_empty_and_inconsistent_reports(self):
        evidence = {"format": "junit", "minimumTests": 1}
        for body, expected in [("<testcase name='a'/>", "PASS"),
                               ("<testcase name='a'><failure/></testcase>", "FAIL"),
                               ("<testcase name='a'><error/></testcase>", "FAIL"),
                               ("<testcase name='a'><skipped/></testcase>", "UNKNOWN")]:
            self.assertEqual(parse(evidence, f"<testsuite>{body}</testsuite>", 1)["verdict"], expected)
        for raw in ["<testsuite tests='0'/>", "<testsuite tests='3'><testcase name='a'/></testsuite>",
                    "<testsuite><testcase name='a'/><testcase name='a'/></testsuite>",
                    "<!DOCTYPE x><testsuite><testcase name='a'/></testsuite>", "<testsuite>"]:
            with self.subTest(raw=raw), self.assertRaises(Exception):
                parse(evidence, raw, 1)

    def test_uvm_zero_exit_cannot_hide_errors_or_missing_summary(self):
        evidence = {"format": "uvm", "testName": "fifo_test"}
        good = "UVM_INFO @ 0: reporter [RNTST] Running test fifo_test...\n--- UVM Report Summary ---\nUVM_ERROR : 0\nUVM_FATAL : 0\n"
        self.assertEqual(parse(evidence, good, 1)["verdict"], "PASS")
        self.assertEqual(parse(evidence, good.replace("ERROR : 0", "ERROR : 2"), 1)["verdict"], "FAIL")
        self.assertEqual(parse(evidence, "UVM_ERROR @ 42: checker failed\n" + good, 1)["verdict"], "FAIL")
        for raw in ("UVM_INFO test started", good + good, "UVM Report Summary\nUVM_ERROR : 0\n"):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                parse(evidence, raw, 1)
        with self.assertRaisesRegex(ValueError, "substituted"):
            parse(evidence, good.replace("fifo_test", "other_test"), 1)

    def test_formal_modes_and_unknown_are_explicit(self):
        for mode, strength in (("bmc", "bounded"), ("cover", "cover"), ("prove", "proof")):
            p = base_plan()
            p["coverage"] = []
            p["inputs"].append("proof.sby")
            p["cases"][0]["evidence"] = {"format": "sby", "path": "proof/status", "config": "proof.sby",
                                             "mode": mode, "depth": 20, "assumptions": ["Synchronous reset"]}
            p["requirements"][0]["evidence"] = strength
            validate(p)
            for raw, expected in (("PASS\n", "PASS"), ("FAIL\n", "FAIL"), ("UNKNOWN\n", "UNKNOWN"), ("ERROR\n", "UNKNOWN")):
                self.assertEqual(parse(p["cases"][0]["evidence"], raw, 1)["verdict"], expected)
            if mode != "prove":
                p["requirements"][0]["evidence"] = "proof"
                with self.assertRaises(ValueError):
                    validate(p)

    def test_formal_mode_must_match_actual_single_task_config(self):
        with tempfile.TemporaryDirectory() as folder:
            p = base_plan()
            p["coverage"] = []
            p["inputs"].append("proof.sby")
            p["cases"][0]["evidence"] = {"format": "sby", "path": "status", "config": "proof.sby", "mode": "prove", "assumptions": []}
            p["cases"][0]["steps"][0]["argv"].append("{project}/proof.sby")
            Path(folder, "proof.sby").write_text("[options]\nmode bmc\ndepth 20\n")
            with self.assertRaisesRegex(ValueError, "mode differs"):
                validate_formal_configs(p, folder)
            Path(folder, "proof.sby").write_text("[options]\nmode prove\n")
            validate_formal_configs(p, folder)


class ExecutionFixture:
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        (self.root / "producer.py").write_text(PRODUCER)
        self.plan = base_plan()

    def run_fixture(self, source=None):
        if source is not None:
            (self.root / "producer.py").write_text(source)
        return run_plan(self.plan, self.root, self.root / "out")


class ExecutionTests(ExecutionFixture, unittest.TestCase):
    def test_seeds_merge_coverage_and_repeated_checks_get_fresh_directories(self):
        report = self.run_fixture()
        self.assertEqual(report["verdict"], "PASS")
        self.assertEqual(report["coverage"][0]["uncoveredBins"], [])
        self.assertNotEqual(report["runs"][0]["directory"], report["runs"][1]["directory"])
        again = self.run_fixture()
        self.assertNotEqual(report["evidenceDirectory"], again["evidenceDirectory"])
        self.assertEqual(report["planHash"], again["planHash"])
        self.assertTrue(Path(report["evidenceDirectory"], "report.json").is_file())

    def test_missing_results_are_unknown_even_with_zero_exit(self):
        report = self.run_fixture("pass\n")
        self.assertEqual(report["verdict"], "UNKNOWN")
        self.assertTrue(all(r["steps"][0]["code"] == 0 for r in report["runs"]))

    def test_nonzero_exit_is_failure_with_retained_logs(self):
        report = self.run_fixture("print('design mismatch',flush=True)\nraise SystemExit(1)\n")
        self.assertEqual(report["verdict"], "FAIL")
        self.assertIn("design mismatch", report["runs"][0]["diagnostic"])
        log = Path(report["runs"][0]["directory"], "step-0.log")
        self.assertIn("design mismatch", log.read_text())
        self.assertIn("sha256", report["runs"][0]["artifacts"]["step-0.log"])

    def test_timeout_and_output_overflow_never_pass(self):
        for source, expected in [("import time;time.sleep(3)", "TIMEOUT"), ("print('x'*100000)", "OUTPUT_LIMIT")]:
            self.plan["cases"][0]["steps"][0]["timeoutMs"] = 100
            report = self.run_fixture(source)
            self.assertEqual(report["verdict"], "UNKNOWN")
            self.assertEqual(report["runs"][0]["error"], expected)
            self.assertLessEqual(Path(report["runs"][0]["directory"], "step-0.log").stat().st_size, self.plan["maxOutputBytes"])

    def test_missing_coverage_and_unhit_bins_are_distinct(self):
        for replacement, expected in [("{}", "UNKNOWN"), ('{"empty":0,"full":0}', "FAIL")]:
            source = PRODUCER.replace('{"empty":int(seed==1),"full":int(seed==17)}', replacement)
            report = self.run_fixture(source)
            self.assertEqual(report["verdict"], expected)
            self.assertEqual(report["coverage"][0]["uncoveredBins"], ["empty", "full"])
            if expected == "UNKNOWN":
                self.assertIsNone(report["coverage"][0]["fraction"])

    def test_source_mutation_invalidates_the_entire_report(self):
        self.plan["cases"][0]["seeds"] = [1]
        source = PRODUCER + "\nPath(__file__).write_text('# changed')\n"
        report = self.run_fixture(source)
        self.assertTrue(report["inputsChanged"])
        self.assertEqual(report["verdict"], "UNKNOWN")

    def test_symlink_evidence_cannot_escape_private_run(self):
        target = self.root / "other.json"
        target.write_text("{}")
        report = self.run_fixture(f"from pathlib import Path\nPath('result.json').symlink_to({str(target)!r})\n")
        self.assertEqual(report["verdict"], "UNKNOWN")
        self.assertIn("escapes", report["runs"][0]["error"])

    def test_required_waveform_is_not_silently_ignored(self):
        self.plan["cases"][0]["artifacts"] = ["trace.vcd"]
        self.assertEqual(self.run_fixture()["verdict"], "UNKNOWN")

    def test_uvm_wrapper_success_does_not_mask_design_failure(self):
        self.plan["cases"][0]["evidence"] = {"format": "uvm", "path": "uvm.log", "testName": "fifo_test"}
        self.plan["coverage"] = []
        report = self.run_fixture("from pathlib import Path\nPath('uvm.log').write_text('UVM_INFO [RNTST] Running test fifo_test...\\nUVM Report Summary\\nUVM_ERROR : 1\\nUVM_FATAL : 0\\n')")
        self.assertEqual(report["verdict"], "FAIL")


class PreparationTests(ExecutionFixture, unittest.TestCase):
    """Prepared work is generic; no RTL is needed to exercise its guarantees."""
    def setUp(self):
        super().setUp()
        (self.root / "prepare.py").write_text("from pathlib import Path\nPath('table.txt').write_text('frozen table')\n")
        self.plan["inputs"].append("prepare.py")
        self.plan["cases"][0]["prepare"] = {"steps": [{"argv": [sys.executable, "{project}/prepare.py"], "timeoutMs": 1000}],
                                              "artifacts": ["table.txt"]}
        self.plan["cases"][0]["steps"][0]["argv"].append("{shared}/table.txt")
        self.source = PRODUCER + "\nassert Path(sys.argv[2]).read_text() == 'frozen table'\n"

    def test_one_preparation_supplies_all_parameterized_runs(self):
        report = self.run_fixture(self.source)
        self.assertEqual(report["verdict"], "PASS")
        self.assertEqual(len(report["prepared"]["trial"]["steps"]), 1)
        self.assertEqual([r["seed"] for r in report["runs"]], [1, 17])
        self.assertTrue(all(r["preparation"] == "trial" for r in report["runs"]))
        again = self.run_fixture(self.source)
        self.assertEqual(again["verdict"], "PASS")
        self.assertNotEqual(report["prepared"]["trial"]["published"], again["prepared"]["trial"]["published"])

    def test_failed_preparation_blocks_every_consumer(self):
        (self.root / "prepare.py").write_text("raise SystemExit(1)\n")
        report = self.run_fixture(self.source)
        self.assertEqual(report["verdict"], "FAIL")
        self.assertTrue(all(r["error"] == "PREPARATION_FAILED" and not r["steps"] for r in report["runs"]))

    def test_missing_or_oversized_prepared_artifacts_are_unknown(self):
        for source in ("pass", "from pathlib import Path\nPath('table.txt').write_text('x'*20000)"):
            (self.root / "prepare.py").write_text(source)
            report = self.run_fixture(self.source)
            self.assertEqual(report["verdict"], "UNKNOWN")
            self.assertTrue(all(not r["steps"] for r in report["runs"]))

    def test_consumer_cannot_change_shared_artifacts_and_claim_pass(self):
        self.plan["cases"][0]["seeds"] = [1]
        source = self.source + "\np=Path(sys.argv[2]);p.chmod(0o644);p.write_text('modified')\n"
        report = self.run_fixture(source)
        self.assertEqual(report["runs"][0]["verdict"], "PASS")
        self.assertTrue(report["sharedArtifactsChanged"])
        self.assertEqual(report["verdict"], "UNKNOWN")

    def test_preparation_cannot_depend_on_a_seed_or_an_undeclared_stage(self):
        for token in ("{seed}", "{shared}"):
            plan = copy.deepcopy(self.plan)
            plan["cases"][0]["prepare"]["steps"][0]["argv"].append(token)
            with self.assertRaises(ValueError):
                validate(plan)
        plan = base_plan()
        plan["cases"][0]["steps"][0]["argv"].append("{shared}/missing")
        with self.assertRaises(ValueError):
            validate(plan)

    def test_generic_stage_supports_nonchip_parameter_names(self):
        import time
        root = self.root / "generic"
        stage = _commands.prepare_stage(self.plan["cases"][0]["prepare"], root,
            {"PATH": os.environ.get("PATH", "")}, {"project": self.root}, time.monotonic() + 3, 4096, 16384)
        self.assertEqual(stage["verdict"], "PASS")
        # This caller uses data/partition labels, no chip/seed/evidence schema.
        for partition in ("left", "right"):
            work = self.root / partition
            work.mkdir()
            code = "from pathlib import Path;import sys;assert Path(sys.argv[1]).read_text()=='frozen table';print(sys.argv[2])"
            steps = [{"argv": [sys.executable, "-c", code, "{dataset}/table.txt", "{partition}"], "timeoutMs": 1000}]
            result = _commands.run_steps(steps, work, {"PATH": os.environ.get("PATH", "")},
                {"dataset": stage["published"], "partition": partition}, time.monotonic() + 3, 4096)
            self.assertEqual(result["verdict"], "PASS")
            self.assertEqual((work / "step-0.log").read_text().strip(), partition)
        self.assertTrue(_commands.prepared_unchanged(stage, 16384))


class RtlIntegrationTests(unittest.TestCase):
    def test_actual_rtl_good_and_deliberate_bug(self):
        ivl = os.environ.get("FUTURE_CHIP_IVERILOG") or shutil.which("iverilog")
        vvp = os.environ.get("FUTURE_CHIP_VVP") or shutil.which("vvp")
        if not ivl or not vvp:
            self.skipTest("Real RTL integration requires Icarus; protocol adversaries still run")
        ivl_root = os.environ.get("FUTURE_CHIP_IVL_ROOT")
        with tempfile.TemporaryDirectory() as output:
            for negative, expected in ((False, "PASS"), (True, "FAIL")):
                reports = []
                for shared in (False, True):
                    plan = configure.make_plan(REPO, ivl, vvp, negative=negative, ivl_root=ivl_root, share_build=shared)
                    report = run_plan(plan, REPO, output)
                    self.assertEqual(report["verdict"], expected, json.dumps(report))
                    self.assertEqual(len(report["runs"]), 3)
                    compilations = sum(len(s["steps"]) for s in report["prepared"].values())
                    compilations += sum(max(0, len(r["steps"]) - 1) for r in report["runs"])
                    self.assertEqual(compilations, 1 if shared else 3)
                    if not negative:
                        self.assertEqual(report["coverage"][0]["fraction"], 1.0)
                        self.assertTrue(all("trace.vcd" in row["artifacts"] for row in report["runs"]))
                    reports.append(report)
                self.assertEqual([[r["verdict"], r["bins"]] for r in reports[0]["runs"]],
                                 [[r["verdict"], r["bins"]] for r in reports[1]["runs"]])


if __name__ == "__main__":
    unittest.main(verbosity=2)
