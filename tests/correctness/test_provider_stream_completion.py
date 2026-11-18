"""Exercise the real local provider bridge; no model API or credentials."""
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import ssl
import tempfile
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("stream_completion_proxy", ROOT / "future_huanxin_future_proxy.py")
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


class QuietBridge(proxy.Handler):
    def log_message(self, *args):
        pass


class HeldOpenUpstream(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.receipts.append(body)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        chunks = [
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call-read", "function": {"name": "Read", "arguments": '{"path":"demo.py"}'}}]}, "finish_reason": None}]},
            {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
            {"choices": [], "usage": {"prompt_tokens": 7, "completion_tokens": 3}},
        ]
        lines = getattr(self.server, "stream_lines", None)
        if lines is None:
            lines = [("data: " + json.dumps(chunk) + "\n\n").encode() for chunk in chunks]
        for line in lines:
            self.wfile.write(line)
        self.wfile.write(getattr(self.server, "terminal_marker", b"data: [DONE]\n\n"))
        self.wfile.flush()
        self.server.terminal_sent.set()
        # HTTP transport stays open after the protocol's terminal marker.
        self.server.release.wait(5)


class QuietStreamUpstream(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"]))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        self.connection.settimeout(3)
        try:
            if self.server.trickle:
                while not self.server.release.wait(0.025):
                    self.wfile.write(b": upstream heartbeat\n\n")
            elif not self.rfile.read(1):
                self.server.peer_closed.set()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            self.server.peer_closed.set()
        except TimeoutError:
            pass


class RetryableUpstream(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"]))
        self.send_response(503)
        self.end_headers()
        self.wfile.write(b'{"error":{"message":"busy"}}')
        if self.server.first_call.is_set():
            self.server.retried.set()
        self.server.first_call.set()


class StreamCompletionTests(unittest.TestCase):
    def start_server(self, handler):
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        self.servers.append((server, thread))
        return server

    def setUp(self):
        self.servers = []
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"FUTURE_CONFIG_DIR": self.temp.name, "HUANXIN_GLM52_RETRIES": "1"})
        self.env.start()

    def tearDown(self):
        for server, thread in self.servers:
            if hasattr(server, "release"):
                server.release.set()
        for server, thread in reversed(self.servers):
            server.shutdown()
            server.server_close()
            thread.join(2)
        self.env.stop()
        self.temp.cleanup()

    def bridge_for(self, upstream):
        bridge = self.start_server(QuietBridge)
        bridge.upstream_url = "http://127.0.0.1:%d/v1/chat/completions" % upstream.server_port
        bridge.upstream_token = "Bearer fixture"
        bridge.model_name = "fixture"
        bridge.appcode = ""
        bridge.max_input_chars = 100000
        bridge.insecure = False
        bridge.verify_context = ssl.create_default_context()
        bridge.insecure_context = ssl._create_unverified_context()
        return bridge

    def quiet_stream(self, trickle=False):
        upstream = self.start_server(QuietStreamUpstream)
        upstream.trickle = trickle
        upstream.release = threading.Event()
        upstream.peer_closed = threading.Event()
        return upstream

    def simple_request(self, bridge):
        body = {"model": "fixture", "stream": True, "messages": [{"role": "user", "content": "Start work"}]}
        return urllib.request.Request("http://127.0.0.1:%d/v1/messages" % bridge.server_port,
                                      data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})

    def test_client_close_reclaims_silent_upstream_before_next_ping(self):
        upstream = self.quiet_stream()
        bridge = self.bridge_for(upstream)
        with urllib.request.urlopen(self.simple_request(bridge), timeout=2) as response:
            self.assertEqual(response.readline(), b"event: message_start\n")
        self.assertTrue(upstream.peer_closed.wait(0.75), "quiet upstream remained open after client cancellation")

    def test_cancelled_client_cannot_submit_a_retry(self):
        upstream = self.start_server(RetryableUpstream)
        upstream.first_call = threading.Event()
        upstream.retried = threading.Event()
        bridge = self.bridge_for(upstream)
        body = self.simple_request(bridge).data
        headers = f"POST /v1/messages HTTP/1.0\r\nContent-Length: {len(body)}\r\n\r\n".encode()
        with patch.dict(os.environ, {"HUANXIN_GLM52_RETRIES": "2", "HUANXIN_GLM52_RETRY_BASE": "0.25"}):
            with socket.create_connection(("127.0.0.1", bridge.server_port), timeout=2) as client:
                client.sendall(headers + body)
                self.assertTrue(upstream.first_call.wait(1))
            self.assertFalse(upstream.retried.wait(0.75), "a cancelled request was submitted again")

    def test_live_stream_wall_deadline_expires_despite_upstream_heartbeats(self):
        upstream = self.quiet_stream(trickle=True)
        bridge = self.bridge_for(upstream)
        with patch.dict(os.environ, {"HUANXIN_PROXY_STREAM_MAX_SECONDS": "0.3"}):
            with urllib.request.urlopen(self.simple_request(bridge), timeout=2) as response:
                result = response.read().decode()
        self.assert_stream_failed(result)
        self.assertIn("Provider stream exceeded its wall-clock limit", result)
        self.assertTrue(upstream.peer_closed.wait(0.75))

    def test_live_stream_idle_limit_is_independent_of_the_wall_deadline(self):
        upstream = self.quiet_stream()
        bridge = self.bridge_for(upstream)
        with patch.dict(os.environ, {"HUANXIN_PROXY_STREAM_IDLE_SECONDS": "0.15", "HUANXIN_PROXY_STREAM_MAX_SECONDS": "5"}):
            with urllib.request.urlopen(self.simple_request(bridge), timeout=2) as response:
                result = response.read().decode()
        self.assert_stream_failed(result)
        self.assertIn("Provider stream exceeded its upstream idle limit", result)
        self.assertTrue(upstream.peer_closed.wait(0.75))

    def test_done_finishes_tool_turn_without_waiting_for_http_eof(self):
        upstream = self.start_server(HeldOpenUpstream)
        upstream.receipts = []
        upstream.terminal_sent = threading.Event()
        upstream.release = threading.Event()
        bridge = self.bridge_for(upstream)
        body = {"model": "fixture", "stream": True, "messages": [{"role": "user", "content": "Read demo.py"}], "tools": [{"name": "Read", "input_schema": {"type": "object"}}]}
        request = urllib.request.Request("http://127.0.0.1:%d/v1/messages" % bridge.server_port, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        completed = threading.Event()
        result = {}

        def read_client():
            try:
                with urllib.request.urlopen(request, timeout=4) as response:
                    result["body"] = response.read().decode()
            except Exception as error:
                result["error"] = error
            finally:
                completed.set()

        client = threading.Thread(target=read_client, daemon=True)
        client.start()
        try:
            self.assertTrue(upstream.terminal_sent.wait(2), "upstream never received the request")
            self.assertTrue(completed.wait(0.75), "bridge held completed tool work until transport EOF")
            self.assertFalse(upstream.release.is_set(), "fixture must keep HTTP open")
            self.assertNotIn("error", result)
            self.assertEqual(len(upstream.receipts), 1)
            self.assertIn('"partial_json":"{\\"path\\":\\"demo.py\\"}"', result["body"])
            self.assertEqual(result["body"].count("event: content_block_stop"), 1)
            self.assertEqual(result["body"].count("event: message_stop"), 1)
            self.assertIn('"input_tokens":7', result["body"])
        finally:
            upstream.release.set()
            client.join(2)

    def run_stream(self, lines, marker=b"data: [DONE]\n\n", hold_open=False, body_extra=None):
        upstream = self.start_server(HeldOpenUpstream)
        upstream.receipts = []
        upstream.terminal_sent = threading.Event()
        upstream.release = threading.Event()
        upstream.stream_lines = lines
        upstream.terminal_marker = marker
        if not hold_open:
            upstream.release.set()
        bridge = self.bridge_for(upstream)
        body = {"model": "fixture", "stream": True, "messages": [{"role": "user", "content": "Read demo.py"}], "tools": [{"name": "Read", "input_schema": {"type": "object"}}]}
        body.update(body_extra or {})
        request = urllib.request.Request("http://127.0.0.1:%d/v1/messages" % bridge.server_port, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=2) as response:
            result = response.read().decode()
        self.assertEqual(len(upstream.receipts), 1, "a started stream must not replay through buffered requests")
        self.assertFalse(any(thread.name.startswith("future-provider-stream-") for thread in threading.enumerate()), "upstream reader leaked after completion")
        return result, upstream

    @staticmethod
    def line(delta, finish_reason=None):
        return ("data: " + json.dumps({"choices": [{"delta": delta, "finish_reason": finish_reason}]}) + "\n\n").encode()

    def assert_stream_failed(self, result):
        self.assertIn("event: error", result)
        self.assertNotIn("event: content_block_stop", result)
        self.assertNotIn("event: message_stop", result)

    def test_done_without_space_and_crlf_is_terminal(self):
        result, upstream = self.run_stream([self.line({"content": "ok"}, "stop")], marker=b"data:[DONE]\r\n\r\n", hold_open=True)
        self.assertIn("event: message_stop", result)
        self.assertFalse(upstream.release.is_set())

    def test_complete_reason_allows_clean_eof_without_done(self):
        for reason, expected in [("stop", "end_turn"), ("length", "max_tokens")]:
            with self.subTest(reason=reason):
                result, _ = self.run_stream([self.line({"content": "ok"}, reason)], marker=b"")
                self.assertIn('"stop_reason":"' + expected + '"', result)
                self.assertIn("event: message_stop", result)

    def test_partial_and_truncated_tool_streams_never_admit_tools(self):
        for arguments, reason, marker in [
            ('{"path":', None, b""),
            ('{"path":', None, b"data: [DONE]\n\n"),
            ('{"path":', "tool_calls", b"data: [DONE]\n\n"),
            ('{"path":"demo.py"}', "length", b"data: [DONE]\n\n"),
            ('{"path":"demo.py"}', "content_filter", b"data: [DONE]\n\n"),
        ]:
            with self.subTest(arguments=arguments, reason=reason, marker=marker):
                result, _ = self.run_stream([self.line({"tool_calls": [{"index": 0, "id": "call-read", "function": {"name": "Read", "arguments": arguments}}]}, reason)], marker=marker)
                self.assert_stream_failed(result)

    def test_oversized_sse_line_fails_instead_of_admitting_a_partial_turn(self):
        with patch.object(proxy, "_MAX_SSE_LINE_BYTES", 256):
            result, _ = self.run_stream([self.line({"content": "x" * 1024}, "stop")])
        self.assert_stream_failed(result)

    def test_upstream_errors_and_parser_faults_do_not_replay_or_fake_completion(self):
        for payload in [b'{"error":{"message":"failed"}}', b'[]', b'null', b'{invalid']:
            with self.subTest(payload=payload):
                # Hold the upstream socket open after the malformed line. The
                # bridge must release its reader without waiting for EOF.
                partial = self.line({"tool_calls": [{"index": 0, "id": "call-read", "function": {"name": "Read", "arguments": '{"path":'}}]})
                result, upstream = self.run_stream([partial, b"data: " + payload + b"\n\n"], marker=b"", hold_open=True)
                self.assert_stream_failed(result)
                self.assertFalse(upstream.release.is_set())

    def test_structured_choice_reaches_actual_upstream_once(self):
        result, upstream = self.run_stream([self.line({"content": "ok"}, "stop")], body_extra={"tool_choice": {"type": "auto"}})
        self.assertEqual(upstream.receipts[0]["tool_choice"], "auto")
        self.assertIn("event: message_stop", result)

    def test_structured_tool_choices_translate_without_a_local_crash(self):
        for source, expected in [
            ({"type": "auto"}, "auto"),
            ({"type": "any"}, "required"),
            ({"type": "none"}, "none"),
            ({"type": "tool", "name": "Read"}, {"type": "function", "function": {"name": "Read"}}),
            ({"type": "function", "function": {"name": "Read"}}, {"type": "function", "function": {"name": "Read"}}),
        ]:
            with self.subTest(source=source):
                self.assertEqual(proxy.convert_tool_choice(source), expected)

    def test_argument_fragments_before_name_are_not_lost(self):
        handler = SimpleNamespace(wfile=io.BytesIO())
        writer = proxy.FutureStreamWriter(handler, "test", "fixture", ["Read"])
        writer.start()
        writer.add_tool_calls([{"index": 0, "function": {"arguments": '{"path":'}}])
        writer.add_tool_calls([{"index": 0, "id": "call-read", "function": {"name": "Read", "arguments": '"demo.py"}'}}])
        writer.finish_reason = "tool_calls"
        writer.finish()
        events = [json.loads(line[6:]) for line in handler.wfile.getvalue().decode().splitlines() if line.startswith("data: ")]
        arguments = "".join(event.get("delta", {}).get("partial_json", "") for event in events)
        self.assertEqual(json.loads(arguments), {"path": "demo.py"})

    def test_ambiguous_tool_name_cannot_be_invented(self):
        handler = SimpleNamespace(wfile=io.BytesIO())
        writer = proxy.FutureStreamWriter(handler, "test", "fixture", ["Read", "Delete"])
        writer.start()
        writer.add_tool_calls([{"index": 0, "function": {"arguments": '{"path":"demo.py"}'}}])
        writer.finish_reason = "tool_calls"
        with self.assertRaises(ValueError):
            writer.finish()
        self.assertNotIn(b"event: content_block_stop", handler.wfile.getvalue())
        self.assertNotIn(b"event: message_stop", handler.wfile.getvalue())

    def test_single_offered_tool_retains_nameless_argument_fragments(self):
        handler = SimpleNamespace(wfile=io.BytesIO())
        writer = proxy.FutureStreamWriter(handler, "test", "fixture", ["Read"])
        writer.start()
        writer.add_tool_calls([{"index": 0, "function": {"arguments": '{"path":'}}])
        writer.add_tool_calls([{"index": 0, "function": {"arguments": '"demo.py"}'}}])
        writer.finish_reason = "tool_calls"
        writer.finish()
        events = [json.loads(line[6:]) for line in handler.wfile.getvalue().decode().splitlines() if line.startswith("data: ")]
        arguments = "".join(event.get("delta", {}).get("partial_json", "") for event in events)
        self.assertEqual(json.loads(arguments), {"path": "demo.py"})

    def test_interleaved_tool_arguments_remain_separate_and_complete(self):
        handler = SimpleNamespace(wfile=io.BytesIO())
        writer = proxy.FutureStreamWriter(handler, "test", "fixture", ["Read", "Search"])
        writer.start()
        writer.add_tool_calls([{"index": 0, "id": "a", "function": {"name": "Read", "arguments": '{"path":'}}])
        writer.add_tool_calls([{"index": 1, "id": "b", "function": {"name": "Search", "arguments": '{"query":"needle"}'}}])
        writer.add_tool_calls([{"index": 0, "function": {"arguments": '"demo.py"}'}}])
        writer.finish_reason = "tool_calls"
        writer.finish()
        events = [json.loads(line[6:]) for line in handler.wfile.getvalue().decode().splitlines() if line.startswith("data: ")]
        arguments = {}
        for event in events:
            if event.get("delta", {}).get("type") == "input_json_delta":
                index = event["index"]
                arguments[index] = arguments.get(index, "") + event["delta"]["partial_json"]
        self.assertEqual({index: json.loads(value) for index, value in arguments.items()}, {0: {"path": "demo.py"}, 1: {"query": "needle"}})
        self.assertEqual(sum(event["type"] == "content_block_stop" for event in events), 2)

    def test_invalid_second_tool_cannot_admit_an_earlier_valid_tool(self):
        handler = SimpleNamespace(wfile=io.BytesIO())
        writer = proxy.FutureStreamWriter(handler, "test", "fixture", ["Read", "Delete"])
        writer.start()
        writer.add_tool_calls([{"index": 0, "id": "a", "function": {"name": "Read", "arguments": '{"path":"demo.py"}'}}])
        writer.add_tool_calls([{"index": 1, "function": {"arguments": "{}"}}])
        writer.finish_reason = "tool_calls"
        with self.assertRaises(ValueError):
            writer.finish()
        self.assertNotIn(b"event: content_block_stop", handler.wfile.getvalue())


if __name__ == "__main__":
    unittest.main()
