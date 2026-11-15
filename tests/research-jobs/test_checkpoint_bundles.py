import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


HELPER = Path(__file__).resolve().parents[2] / "scripts/research_job_checkpoints.py"
spec = importlib.util.spec_from_file_location("research_job_checkpoints", HELPER)
checkpoints = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checkpoints)


class CheckpointBundlesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = self.base / "checkpoints"
        self.source = self.base / "source"
        self.source.mkdir()
        self.contract = "a" * 64
        self.required = ["parameters", "execution"]

    def publish(self, step, execution_step=None):
        (self.source / "parameters.bin").write_text(str(step * 10))
        (self.source / "state.json").write_text(json.dumps({"step": step, "counter": step * 10}))
        return checkpoints.publish_bundle(self.root, self.source, step, self.contract, {
            "parameters": {"path": "parameters.bin", "step": step},
            "execution": {"path": "state.json", "step": step if execution_step is None else execution_step},
        })

    def test_publish_and_resolve_exact_complete_generation(self):
        bundle = self.publish(3)
        result = checkpoints.resolve_bundle(self.root, self.contract, self.required)
        self.assertEqual(Path(result["path"]), bundle)
        self.assertEqual(result["step"], 3)
        self.assertEqual(set(result["files"]), set(self.required))
        self.assertEqual((bundle / "parameters").read_text(), "30")
        self.assertEqual(json.loads((bundle / "execution").read_text())["step"], 3)

    def test_partial_newest_and_arbitrary_directory_names_do_not_hide_previous(self):
        previous = self.publish(10)
        partial = self.root / "new-launcher-layout"
        partial.mkdir()
        (partial / "parameters").write_text("120")
        result = checkpoints.resolve_bundle(self.root, self.contract, self.required)
        self.assertEqual(Path(result["path"]), previous)
        self.assertEqual(result["step"], 10)

    def test_step_mismatch_is_rejected_without_publishing(self):
        with self.assertRaises(ValueError):
            self.publish(12, execution_step=10)
        self.assertIsNone(checkpoints.resolve_bundle(self.root, self.contract, self.required))

    def test_corrupt_newest_falls_back_to_previous_complete_pair(self):
        older = self.publish(10)
        newer = self.publish(12)
        (newer / "parameters").write_text("999")
        result = checkpoints.resolve_bundle(self.root, self.contract, self.required)
        self.assertEqual(Path(result["path"]), older)
        self.assertEqual(json.loads((Path(result["path"]) / "execution").read_text())["step"], 10)

    def test_corrupt_manifest_and_extra_component_fail_closed(self):
        bundle = self.publish(12)
        (bundle / "extra").write_text("not declared")
        self.assertIsNone(checkpoints.resolve_bundle(self.root, self.contract, self.required))
        (bundle / "extra").unlink()
        (bundle / "manifest.json").write_text('{"schema":1,"schema":1}')
        self.assertIsNone(checkpoints.resolve_bundle(self.root, self.contract, self.required))

    def test_manifest_component_step_tampering_is_rejected(self):
        bundle = self.publish(12)
        manifest_path = bundle / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["files"]["execution"]["step"] = 13
        manifest_path.write_text(json.dumps(manifest))
        self.assertIsNone(checkpoints.resolve_bundle(self.root, self.contract, self.required))

    def test_contract_or_component_set_change_cannot_resume(self):
        self.publish(12)
        self.assertIsNone(checkpoints.resolve_bundle(self.root, "b" * 64, self.required))
        self.assertIsNone(checkpoints.resolve_bundle(self.root, self.contract, ["parameters"]))

    def test_published_bytes_are_independent_of_mutable_source(self):
        bundle = self.publish(1)
        (self.source / "parameters.bin").write_text("200")
        self.assertEqual((bundle / "parameters").read_text(), "10")
        self.assertEqual(checkpoints.resolve_bundle(self.root, self.contract, self.required)["step"], 1)

    def test_same_step_publication_does_not_overwrite_existing_generation(self):
        first = self.publish(1)
        second = self.publish(1)
        self.assertNotEqual(first, second)
        self.assertEqual((first / "parameters").read_text(), "10")

    def test_no_symlink_components_or_directory_candidates(self):
        self.publish(1)
        (self.source / "parameters.bin").unlink()
        (self.source / "parameters.bin").symlink_to(self.source / "state.json")
        with self.assertRaises((ValueError, OSError)):
            checkpoints.publish_bundle(self.root, self.source, 2, self.contract, {
                "parameters": {"path": "parameters.bin", "step": 2},
            })
        external = self.base / "external"
        external.mkdir()
        (self.root / "foreign").symlink_to(external, target_is_directory=True)
        self.assertEqual(checkpoints.resolve_bundle(self.root, self.contract, self.required)["step"], 1)

    def test_budgets_and_invalid_component_paths(self):
        self.publish(1)
        self.assertIsNone(checkpoints.resolve_bundle(self.root, self.contract, self.required, max_bytes=1))
        for path in ("../state.json", "/etc/passwd", "sub/../../state.json"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                checkpoints.publish_bundle(self.root, self.source, 2, self.contract, {
                    "parameters": {"path": path, "step": 2},
                })
        for invalid_step in (True, -1, 1.5):
            with self.subTest(step=invalid_step), self.assertRaises(ValueError):
                checkpoints.publish_bundle(self.root, self.source, invalid_step, self.contract, {})

    def test_resume_trajectory_equals_uninterrupted_result(self):
        self.publish(3)
        # Simulate a crash while writing step 4. Only completed step 3 survives.
        (self.root / "incomplete-four").mkdir()
        resumed = checkpoints.resolve_bundle(self.root, self.contract, self.required)
        state = json.loads((Path(resumed["path"]) / "execution").read_text())
        value = int((Path(resumed["path"]) / "parameters").read_text())
        self.assertEqual(state["step"], resumed["step"])
        for _ in range(state["step"], 6):
            value += 10
        self.assertEqual(value, sum(10 for _ in range(6)))

    def test_source_mutation_during_copy_is_rejected_and_previous_preserved(self):
        previous = self.publish(1)
        real_fsync = checkpoints.os.fsync
        changed = False

        def mutate(fd):
            nonlocal changed
            real_fsync(fd)
            if not changed:
                changed = True
                (self.source / "parameters.bin").write_text("corrupted while copying")

        with mock.patch.object(checkpoints.os, "fsync", side_effect=mutate), self.assertRaises(ValueError):
            self.publish(2)
        self.assertEqual(Path(checkpoints.resolve_bundle(self.root, self.contract, self.required)["path"]), previous)

    def test_failed_atomic_publication_does_not_erase_previous(self):
        previous = self.publish(1)
        with mock.patch.object(checkpoints.os, "rename", side_effect=OSError("fixture: storage unavailable")):
            with self.assertRaises(OSError):
                self.publish(2)
        self.assertEqual(Path(checkpoints.resolve_bundle(self.root, self.contract, self.required)["path"]), previous)
        self.assertEqual(list(self.root.glob(".pending-*")), [])

    def test_nested_symlink_directory_is_not_followed(self):
        outside = self.base / "outside"
        outside.mkdir()
        (outside / "state").write_text("foreign state")
        (self.source / "subdir").symlink_to(outside, target_is_directory=True)
        with self.assertRaises((OSError, ValueError)):
            checkpoints.publish_bundle(self.root, self.source, 1, self.contract, {
                "state": {"path": "subdir/state", "step": 1},
            })

    def test_invalid_resolution_contracts_are_rejected(self):
        for names in ([], ["one", "one"], ["../state"], [["nested"]]):
            with self.subTest(names=names), self.assertRaises(ValueError):
                checkpoints.resolve_bundle(self.root, self.contract, names)
        with self.assertRaises(ValueError):
            checkpoints.resolve_bundle(self.root, "not-a-hash", self.required)

    def test_expired_resolution_deadline_is_not_missing_evidence(self):
        self.publish(1)
        with self.assertRaises(TimeoutError):
            checkpoints.resolve_bundle(self.root, self.contract, self.required,
                                       deadline=checkpoints.time.monotonic() - 1)
        # Default remains compatible and a future deadline permits resolution.
        self.assertEqual(checkpoints.resolve_bundle(self.root, self.contract, self.required,
                         deadline=checkpoints.time.monotonic() + 30)["step"], 1)
        for deadline in (True, float("inf"), float("nan"), "now"):
            with self.subTest(deadline=deadline), self.assertRaises(ValueError):
                checkpoints.resolve_bundle(self.root, self.contract, self.required, deadline=deadline)

    def test_deadline_interrupts_large_hash_without_falling_back(self):
        self.publish(1)
        (self.source / "parameters.bin").write_bytes(b"x" * (3 * 1024 * 1024))
        (self.source / "state.json").write_text('{"step":2}')
        checkpoints.publish_bundle(self.root, self.source, 2, self.contract, {
            "parameters": {"path": "parameters.bin", "step": 2},
            "execution": {"path": "state.json", "step": 2},
        })
        real_sha256 = checkpoints.hashlib.sha256
        expired = False
        large_chunks = 0

        class HashWithElapsedBudget:
            def __init__(self):
                self.hash = real_sha256()

            def update(self, data):
                nonlocal expired, large_chunks
                self.hash.update(data)
                if len(data) >= 1024 * 1024:
                    large_chunks += 1
                    expired = True

            def hexdigest(self):
                return self.hash.hexdigest()

        with mock.patch.object(checkpoints.hashlib, "sha256", side_effect=HashWithElapsedBudget), \
                mock.patch.object(checkpoints.time, "monotonic", side_effect=lambda: 20.0 if expired else 10.0):
            with self.assertRaises(TimeoutError):
                checkpoints.resolve_bundle(self.root, self.contract, self.required, deadline=15.0)
        self.assertEqual(large_chunks, 1)

    def test_earlier_component_changes_during_later_hash_are_rejected(self):
        real_sha256 = checkpoints.hashlib.sha256
        for mutation in ("rewrite", "replace", "symlink", "directory-replace"):
            with self.subTest(mutation=mutation):
                # Keep this subcase separate from other candidate generations.
                self.root = self.base / mutation
                previous = self.publish(1)
                newest = self.publish(2)
                hashes = 0

                def mutate_on_second_hash():
                    nonlocal hashes
                    hashes += 1
                    if hashes == 2:
                        first = newest / "execution"  # Manifest's first sorted component.
                        if mutation == "rewrite":
                            first.write_text("corrupted while another component is hashing")
                        elif mutation == "replace":
                            replacement = self.base / "replacement"
                            replacement.write_bytes(first.read_bytes())
                            replacement.replace(first)
                        elif mutation == "symlink":
                            first.unlink()
                            first.symlink_to(previous / "execution")
                        else:
                            moved = self.base / "renamed-checkpoint"
                            newest.rename(moved)
                            newest.symlink_to(moved, target_is_directory=True)
                    return real_sha256()

                with mock.patch.object(checkpoints.hashlib, "sha256", side_effect=mutate_on_second_hash):
                    selected = checkpoints.resolve_bundle(self.root, self.contract, self.required)
                self.assertEqual(Path(selected["path"]), previous)
                self.assertEqual(selected["step"], 1)

    def test_cli_publish_and_resolve(self):
        (self.source / "state.json").write_text('{"step":4}')
        components = self.base / "components.json"
        components.write_text(json.dumps({"state": {"path": "state.json", "step": 4}}))
        common = [sys.executable, str(HELPER)]
        publication = subprocess.run(common + ["publish", "--root", str(self.root), "--source", str(self.source),
            "--step", "4", "--contract", self.contract, "--components", str(components)],
            capture_output=True, text=True, timeout=5)
        self.assertEqual(publication.returncode, 0, publication.stderr)
        resolution = subprocess.run(common + ["resolve", "--root", str(self.root), "--contract", self.contract,
            "--component", "state"], capture_output=True, text=True, timeout=5)
        self.assertEqual(resolution.returncode, 0, resolution.stderr)
        self.assertEqual(json.loads(resolution.stdout)["step"], 4)


if __name__ == "__main__":
    unittest.main()
