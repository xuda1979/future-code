"""Exercise the real shell launcher and local proxy without upstream requests."""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

LAUNCHER = Path(__file__).resolve().parents[2] / "future-code.sh"


@unittest.skipUnless(os.name == "posix", "POSIX launcher")
class LauncherLifecycle(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="launcher-lifecycle-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / "fixture.env"
        self.config.write_text("FUTURE_CODE_API_KEY=offline-fixture\n"
                               "FUTURE_CODE_BASE_URL=http://127.0.0.1:1\n"
                               "FUTURE_CODE_MODEL=offline-fixture\n")
        self.binary = self.root / "binary"
        self.record = self.root / "record.json"
        self.child = self.root / "child.json"

    def launch(self, code, stdin=None):
        self.binary.write_text(f"#!{sys.executable}\n" + code)
        self.binary.chmod(0o700)
        env = {**os.environ, "FUTURE_CODE_CONFIG_FILE": str(self.config),
               "FUTURE_CODE_BIN": str(self.binary), "TMPDIR": str(self.root)}
        proc = subprocess.Popen(["bash", str(LAUNCHER), "fixture-argument"], env=env,
                                stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, start_new_session=True)
        self.addCleanup(self.cleanup_group, proc)
        return proc

    @staticmethod
    def cleanup_group(proc):
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.communicate(timeout=5)

    def assert_proxy_stopped(self, stderr):
        endpoint = re.search(r"proxy ready on (http://127\.0\.0\.1:\d+)", stderr)
        self.assertIsNotNone(endpoint, stderr)
        with self.assertRaises((urllib.error.URLError, TimeoutError, ConnectionError)):
            urllib.request.urlopen(endpoint.group(1) + "/health", timeout=1)

    def test_exit_reaps_proxy_and_preserves_status_arguments_and_stdin(self):
        code = ("import json,sys\nfrom pathlib import Path\n"
                f"Path({str(self.record)!r}).write_text(json.dumps([sys.argv[1:],sys.stdin.read()]))\n"
                "sys.exit(37)\n")
        proc = self.launch(code, subprocess.PIPE)
        _, stderr = proc.communicate("terminal input\n", timeout=10)
        self.assertEqual(proc.returncode, 37)
        args, stdin = json.loads(self.record.read_text())
        self.assertEqual(args[-1], "fixture-argument")
        self.assertEqual(stdin, "terminal input\n")
        self.assert_proxy_stopped(stderr)

    def test_wrapper_forwards_signals_waits_for_child_and_reaps_proxy(self):
        for sig in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(signal=sig.name):
                self.child.unlink(missing_ok=True)
                self.record.unlink(missing_ok=True)
                code = ("import json,os,signal,time\nfrom pathlib import Path\n"
                        "def stop(sig, frame):\n"
                        f"    Path({str(self.record)!r}).write_text(str(sig))\n"
                        "    raise SystemExit(128+sig)\n"
                        "signal.signal(signal.SIGINT,stop)\nsignal.signal(signal.SIGTERM,stop)\n"
                        f"Path({str(self.child)!r}).write_text(json.dumps(os.getpid()))\n"
                        "while True: time.sleep(0.02)\n")
                proc = self.launch(code)
                deadline = time.monotonic() + 10
                while not self.child.exists() and proc.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(self.child.exists(), "binary did not start")
                child_pid = json.loads(self.child.read_text())
                proc.send_signal(sig)
                _, stderr = proc.communicate(timeout=10)
                self.assertEqual(proc.returncode, 128 + sig)
                self.assertEqual(self.record.read_text(), str(int(sig)))
                with self.assertRaises(ProcessLookupError):
                    os.kill(child_pid, 0)
                self.assert_proxy_stopped(stderr)


if __name__ == "__main__":
    unittest.main()
