import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
import urllib.error
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
PROXY_PATH = ROOT / "future_huanxin_future_proxy.py"
LAUNCHER_PATH = ROOT / "future-code.sh"


def load_proxy():
    spec = importlib.util.spec_from_file_location("future_huanxin_future_proxy", PROXY_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


class LauncherLatencyPolicyTest(unittest.TestCase):
    def run_launcher(self, extra_env=None):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            config = td / "test.env"
            config.write_text(
                "DEEPSEEK_API_KEY=test-key\n"
                "DEEPSEEK_BASE_URL=https://example.invalid/future\n"
                "DEEPSEEK_MODEL_NAME=GLM-5.3\n",
                encoding="utf-8",
            )
            fake = td / "fake-future"
            fake.write_text(
                "#!/usr/bin/env bash\n"
                "printf 'EFFORT=%s\\n' \"$FUTURE_CODE_EFFORT_LEVEL\"\n"
                "printf 'RETRY=%s\\n' \"$FUTURE_CODE_UNATTENDED_RETRY\"\n"
                "printf 'SMALL=%s\\n' \"$FUTURE_SMALL_FAST_MODEL\"\n"
                "printf 'SUBAGENT=%s\\n' \"$FUTURE_CODE_SUBAGENT_MODEL\"\n"
                "printf 'ARGS='\n"
                "printf '%s|' \"$@\"\n"
                "printf '\\n'\n",
                encoding="utf-8",
            )
            fake.chmod(0o755)
            env = os.environ.copy()
            for key in (
                "FUTURE_CODE_EFFORT_LEVEL",
                "FUTURE_CODE_UNATTENDED_RETRY",
                "FUTURE_CODE_SMALL_MODEL",
                "FUTURE_SMALL_FAST_MODEL",
                "FUTURE_CODE_SUBAGENT_MODEL",
                "DEEPSEEK_EFFORT_LEVEL",
                "DEEPSEEK_SMALL_MODEL_NAME",
            ):
                env.pop(key, None)
            env.update({
                "FUTURE_CODE_CONFIG_FILE": str(config),
                "FUTURE_CODE_BIN": str(fake),
            })
            if extra_env:
                env.update(extra_env)
            return subprocess.run(
                ["bash", str(LAUNCHER_PATH), "--print", "hello"],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

    def test_interactive_defaults_are_bounded_and_balanced(self):
        result = self.run_launcher()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("EFFORT=medium", result.stdout)
        self.assertIn("RETRY=0", result.stdout)
        self.assertIn("SMALL=GLM-5.3", result.stdout)
        self.assertIn("SUBAGENT=GLM-5.3", result.stdout)
        self.assertIn("ARGS=--model|GLM-5.3|--effort|medium|--print|hello|", result.stdout)

    def test_explicit_deep_and_persistent_settings_are_preserved(self):
        result = self.run_launcher({
            "FUTURE_CODE_EFFORT_LEVEL": "max",
            "FUTURE_CODE_UNATTENDED_RETRY": "1",
            "FUTURE_SMALL_FAST_MODEL": "fast-helper",
            "FUTURE_CODE_SUBAGENT_MODEL": "deep-subagent",
        })
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("EFFORT=max", result.stdout)
        self.assertIn("RETRY=1", result.stdout)
        self.assertIn("SMALL=fast-helper", result.stdout)
        self.assertIn("SUBAGENT=deep-subagent", result.stdout)
        self.assertIn("ARGS=--model|GLM-5.3|--effort|max|--print|hello|", result.stdout)


class ProxyLatencyPolicyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.proxy = load_proxy()

    def test_glm52_respects_client_effort(self):
        server = SimpleNamespace(model_name="glm5.2", max_input_chars=100000)
        body = {
            "messages": [{"role": "user", "content": "small task"}],
            "output_config": {"effort": "low"},
            "max_tokens": 1024,
        }
        upstream = self.proxy.build_upstream_body(server, body)
        self.assertEqual(upstream["reasoning_effort"], "low")
        self.assertEqual(upstream["thinking"], {"type": "enabled"})

    def test_non_glm_routes_have_no_implicit_spacing(self):
        server = SimpleNamespace(model_name="GLM-5.3")
        with mock.patch.object(self.proxy._time_mod, "sleep") as sleep:
            self.proxy._last_upstream_call_at = self.proxy._time_mod.monotonic()
            self.proxy._reserve_upstream_slot(server)
            sleep.assert_not_called()

    def test_retry_owner_is_bounded_by_default(self):
        old = os.environ.pop("HUANXIN_GLM52_RETRIES", None)
        try:
            tries, _ = self.proxy._retry_config()
            self.assertEqual(tries, 3)
        finally:
            if old is not None:
                os.environ["HUANXIN_GLM52_RETRIES"] = old

    def test_terminal_stream_error_is_handled_without_buffered_retry(self):
        proxy = self.proxy
        server = SimpleNamespace(
            model_name="GLM-5.3",
            max_input_chars=100000,
            upstream_url="https://example.invalid/v1/chat/completions",
            upstream_token="Bearer test",
            appcode="",
            insecure=False,
            verify_context=None,
            insecure_context=None,
        )

        class FakeHandler:
            def __init__(self):
                self.status = None
                self.headers = {}
                self.wfile = io.BytesIO()
            def send_response(self, status):
                self.status = status
            def send_header(self, name, value):
                self.headers[name] = value
            def end_headers(self):
                pass

        handler = FakeHandler()
        body = {"messages": [{"role": "user", "content": "hi"}], "stream": True}
        error = urllib.error.HTTPError(
            server.upstream_url,
            503,
            "unavailable",
            {},
            io.BytesIO(b'{"error":{"message":"busy","type":"upstream_http_error"}}'),
        )
        with mock.patch.object(proxy, "_retry_config", return_value=(1, 0.0)), \
             mock.patch.object(proxy.urllib.request, "urlopen", side_effect=error) as urlopen:
            handled = proxy.Handler.stream_live(handler, server, body)

        self.assertTrue(handled)
        self.assertEqual(handler.status, 503)
        self.assertEqual(urlopen.call_count, 1)
        payload = json.loads(handler.wfile.getvalue().decode("utf-8"))
        self.assertEqual(payload["error"]["message"], "busy")


if __name__ == "__main__":
    unittest.main()
