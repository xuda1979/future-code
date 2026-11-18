#!/usr/bin/env python3
"""Paired production-bridge timing with a controlled local SSE upstream.

No live LLM, agent benchmark score, or estimate of human completion time.
The upstream completes its response, then keeps its HTTP connection open.
Measure when the bridge actually releases the completed tool call and turn.
"""
import argparse
import hashlib
import http.client
import importlib.util
import json
import os
import platform
import ssl
import statistics
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SOURCE = "future_huanxin_future_proxy.py"


class Upstream(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        assert body["stream"] is True
        self.server.requests += 1
        call_id = f"call-inspect-{self.server.requests}"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        chunks = [
            {"choices": [{"delta": {"reasoning_content": "Inspect the fixture."}, "finish_reason": None}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": call_id, "function": {
                "name": "Read", "arguments": '{"file_path":"fixture.txt"}'}}]}, "finish_reason": None}]},
            {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
            {"choices": [], "usage": {"prompt_tokens": 8, "completion_tokens": 3}},
        ]
        for chunk in chunks:
            self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()
        # Model output is complete. This controlled delay is transport idle
        # time, not simulated inference or a measured real-provider delay.
        self.server.idle_release.wait(self.server.hold_seconds)


def start(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    return server, thread


def stop(server, thread):
    server.shutdown()
    server.server_close()
    thread.join(2)
    assert not thread.is_alive()


def load_proxy(root, name):
    spec = importlib.util.spec_from_file_location(name, root / SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def trial(module, rounds, hold_seconds, directory):
    class Bridge(module.Handler):
        def log_message(self, *_args):
            pass

    upstream, upstream_thread = start(Upstream)
    upstream.requests = 0
    upstream.hold_seconds = hold_seconds
    upstream.idle_release = threading.Event()
    bridge, bridge_thread = start(Bridge)
    bridge.upstream_url = f"http://127.0.0.1:{upstream.server_port}/v1/chat/completions"
    bridge.upstream_token = "local-fixture-key"
    bridge.model_name = "local-fixture"
    bridge.appcode = ""
    bridge.max_input_chars = 1_000_000
    bridge.insecure = False
    bridge.verify_context = ssl.create_default_context()
    bridge.insecure_context = ssl.create_default_context()
    receipts, timings, warmup = [], [], None
    messages = [{"role": "user", "content": "Read fixture.txt and report the receipt."}]
    try:
        for index in range(rounds + 1):
            request = {"model": "local-fixture", "stream": True, "max_tokens": 1024,
                       "messages": messages,
                       "tools": [{"name": "Read", "description": "Read a UTF-8 file.", "input_schema": {"type": "object",
                           "properties": {"file_path": {"type": "string"}}, "required": ["file_path"]}}]}
            connection = http.client.HTTPConnection("127.0.0.1", bridge.server_port, timeout=5)
            blocks, stopped, usage, terminal = {}, set(), None, None
            tool_ready_ms = None
            began = time.perf_counter()
            try:
                connection.request("POST", "/v1/messages", json.dumps(request), {"Content-Type": "application/json"})
                response = connection.getresponse()
                assert response.status == 200, response.status
                for raw_line in response:
                    if not raw_line.startswith(b"data:"):
                        continue
                    event = json.loads(raw_line[5:])
                    kind = event["type"]
                    assert kind != "error", event
                    if kind == "content_block_start":
                        blocks[event["index"]] = {**event["content_block"], "json": "", "thinking": ""}
                    elif kind == "content_block_delta":
                        delta = event["delta"]
                        block = blocks[event["index"]]
                        block["json"] += delta.get("partial_json", "")
                        block["thinking"] += delta.get("thinking", "")
                    elif kind == "content_block_stop":
                        stopped.add(event["index"])
                        if blocks[event["index"]]["type"] == "tool_use":
                            tool_ready_ms = (time.perf_counter() - began) * 1000
                    elif kind == "message_delta":
                        usage = event["usage"]
                        terminal = event["delta"]["stop_reason"]
                    elif kind == "message_stop":
                        break
                complete_ms = (time.perf_counter() - began) * 1000
            finally:
                connection.close()
            assert terminal == "tool_use" and tool_ready_ms is not None
            assert stopped == set(blocks)
            assert usage == {"input_tokens": 8, "output_tokens": 3}, usage
            tools = [b for b in blocks.values() if b["type"] == "tool_use"]
            call_id = f"call-inspect-{index + 1}"
            assert len(tools) == 1 and tools[0]["id"] == call_id and tools[0]["name"] == "Read"
            arguments = json.loads(tools[0]["json"])
            assert arguments == {"file_path": "fixture.txt"}, arguments
            assert any(b["thinking"] == "Inspect the fixture." for b in blocks.values())
            # A local read after the bridge releases the tool proves every
            # measured round retained identical usable arguments and output.
            content = (directory / arguments["file_path"]).read_bytes()
            if index == 0:
                warmup = {"tool_ready_ms": tool_ready_ms, "complete_ms": complete_ms}
                continue
            receipt = {"tool": "Read", "arguments": arguments,
                       "output_sha256": hashlib.sha256(content).hexdigest(), "usage": usage}
            receipts.append(receipt)
            timings.append({"tool_ready_ms": tool_ready_ms, "complete_ms": complete_ms})
            messages.extend([
                {"role": "assistant", "content": [{"type": "tool_use", "id": call_id,
                                                      "name": "Read", "input": arguments}]},
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": call_id,
                                                 "content": content.decode()}]},
            ])
        assert upstream.requests == rounds + 1, (upstream.requests, rounds + 1)
        return {"rounds": rounds, "upstream_requests": upstream.requests,
                "bridge_total_ms": sum(t["complete_ms"] for t in timings), "timings": timings, "warmup": warmup,
                "receipt_sha256": hashlib.sha256(json.dumps(receipts, sort_keys=True).encode()).hexdigest()}
    finally:
        upstream.idle_release.set()
        stop(bridge, bridge_thread)
        stop(upstream, upstream_thread)


def revision(root):
    return subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()


def native_trial(runtime, rounds, hold_seconds, directory):
    upstream, thread = start(Upstream)
    upstream.requests = 0
    upstream.hold_seconds = hold_seconds
    upstream.idle_release = threading.Event()
    try:
        result = subprocess.run(["node", str(ROOT / "scripts/provider-native-probe.mjs"), str(runtime),
                                 f"http://127.0.0.1:{upstream.server_port}/v1", str(rounds), str(directory)],
                                text=True, capture_output=True, timeout=30)
        if result.returncode != 0:
            raise RuntimeError("OpenCode native probe failed:\n" + result.stderr)
        measured = json.loads(result.stdout)
        assert upstream.requests == rounds + 1
        measured["upstream_requests"] = upstream.requests
        measured["receipt_sha256"] = hashlib.sha256(json.dumps(measured.pop("receipts"), sort_keys=True).encode()).hexdigest()
        return measured
    finally:
        upstream.idle_release.set()
        stop(upstream, thread)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("--samples", type=int, default=5)
    parser.add_argument("--hold-ms", type=float, default=200)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--opencode-runtime", type=Path, help="Optional npm prefix with @opencode/ai@2.3.0 installed")
    args = parser.parse_args()
    assert 1 <= args.samples <= 20 and 0 <= args.hold_ms <= 1000
    roots = {"baseline": args.baseline.resolve(), "candidate": ROOT}
    source_hashes = {arm: hashlib.sha256((root / SOURCE).read_bytes()).hexdigest() for arm, root in roots.items()}
    fixture_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    native_source = None
    if args.opencode_runtime:
        native_root = args.opencode_runtime.resolve()
        manifest = json.loads((native_root / "node_modules/@opencode/ai/package.json").read_text())
        lock = json.loads((native_root / "package-lock.json").read_text())
        assert manifest["version"] == "2.3.0"
        native_source = {"package": "@opencode/ai", "version": manifest["version"],
                         "package_integrity": lock["packages"]["node_modules/@opencode/ai"]["integrity"],
                         "package_resolved": lock["packages"]["node_modules/@opencode/ai"]["resolved"],
                         "package_lock_sha256": hashlib.sha256((native_root / "package-lock.json").read_bytes()).hexdigest(),
                         "protocol_sha256": hashlib.sha256((native_root / "node_modules/@opencode/ai/dist/protocols/openai-chat.js").read_bytes()).hexdigest(),
                         "probe_sha256": hashlib.sha256((ROOT / "scripts/provider-native-probe.mjs").read_bytes()).hexdigest()}
    scenarios = {"single_tool": (1, args.hold_ms / 1000),
                 "repeated_12_turns": (12, args.hold_ms / 1000), "immediate_eof": (1, 0)}
    runs = []
    env = {key: value for key, value in os.environ.items() if not key.startswith("HUANXIN_")}
    with tempfile.TemporaryDirectory(prefix="bridge-terminal-bench-") as temp, patch.dict(os.environ, env, clear=True):
        directory = Path(temp)
        (directory / "fixture.txt").write_text("verified local fixture\n")
        os.environ["FUTURE_CONFIG_DIR"] = temp
        os.environ["HUANXIN_GLM52_RETRIES"] = "1"
        # The first commit applies this knob to every upstream, including the fixture.
        os.environ["HUANXIN_GLM52_MIN_SPACING"] = "0"
        os.environ["HUANXIN_UPSTREAM_MIN_SPACING"] = "0"
        modules = {arm: load_proxy(root, f"benchmark_{arm}") for arm, root in roots.items()}
        for sample in range(args.samples):
            names = list(roots) + (["opencode_native"] if native_source else [])
            offset = sample % len(names)
            arms = names[offset:] + names[:offset]
            for arm in arms:
                for scenario, (rounds, hold) in scenarios.items():
                    result = native_trial(native_root, rounds, hold, directory) if arm == "opencode_native" else trial(modules[arm], rounds, hold, directory)
                    runs.append({"sample": sample, "arm": arm, "scenario": scenario,
                                 **result})
    results = {}
    for scenario in scenarios:
        comparable = [run for run in runs if run["scenario"] == scenario]
        assert len({run["receipt_sha256"] for run in comparable}) == 1, "Receipts differ across arms"
        results[scenario] = {}
        for arm in names:
            selected = [run for run in comparable if run["arm"] == arm]
            results[scenario][arm] = {
                "median_total_ms": statistics.median(run["bridge_total_ms"] for run in selected),
                "median_tool_ready_ms": statistics.median(t["tool_ready_ms"] for run in selected for t in run["timings"]),
                "total_upstream_requests": sum(run["upstream_requests"] for run in selected),
            }
    for arm, root in roots.items():
        assert hashlib.sha256((root / SOURCE).read_bytes()).hexdigest() == source_hashes[arm], "Source changed during measurement"
    assert hashlib.sha256(Path(__file__).read_bytes()).hexdigest() == fixture_hash, "Fixture changed during measurement"
    if native_source:
        assert hashlib.sha256((ROOT / "scripts/provider-native-probe.mjs").read_bytes()).hexdigest() == native_source["probe_sha256"]
        assert hashlib.sha256((native_root / "node_modules/@opencode/ai/dist/protocols/openai-chat.js").read_bytes()).hexdigest() == native_source["protocol_sha256"]
        assert hashlib.sha256((native_root / "package-lock.json").read_bytes()).hexdigest() == native_source["package_lock_sha256"]
    report = {"schema": 1, "kind": "CONTROLLED_LOCAL_BRIDGE_NOT_LIVE_AGENT_PRODUCTIVITY",
              "runtime": {"python": platform.python_version(), "platform": platform.system(), "arch": platform.machine()},
              "samples_per_arm": args.samples, "warmup_requests_per_trial": 1,
              "controlled_post_done_hold_ms": args.hold_ms,
              "sources": {arm: {"revision": revision(root), "sha256": source_hashes[arm]}
                          for arm, root in roots.items()},
              "opencode_native": native_source,
              "fixture_sha256": fixture_hash, "results": results, "runs": runs}
    output = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output)
    print(output)


if __name__ == "__main__":
    main()
