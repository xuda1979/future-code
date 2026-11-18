#!/usr/bin/env python3
"""Exercise real headless CLIs on one independently checked edit with a local scripted provider."""
import argparse
from collections import defaultdict
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
from threading import Thread

ROOT = Path(__file__).resolve().parents[1]
MODEL = "claude-sonnet-4-6"
OLD = 'bool(row.get("verified"))'
NEW = 'row.get("verified") is True'
FUTURE_ARMS = {"first-compatible", "baseline", "candidate"}


def message_events(tool, arguments):
    usage = {"input_tokens": 32, "output_tokens": 0}
    yield {"type": "message_start", "message": {
        "id": "msg_fixture", "type": "message", "role": "assistant", "model": MODEL,
        "content": [], "stop_reason": None, "stop_sequence": None, "usage": usage,
    }}
    if tool:
        block = {"type": "tool_use", "id": "toolu_fixture", "name": tool, "input": {}}
        delta = {"type": "input_json_delta", "partial_json": json.dumps(arguments)}
    else:
        block = {"type": "text", "text": ""}
        delta = {"type": "text_delta", "text": "Finished the requested edit."}
    yield {"type": "content_block_start", "index": 0, "content_block": block}
    yield {"type": "content_block_delta", "index": 0, "delta": delta}
    yield {"type": "content_block_stop", "index": 0}
    yield {"type": "message_delta", "delta": {
        "stop_reason": "tool_use" if tool else "end_turn", "stop_sequence": None,
    }, "usage": {"output_tokens": 12}}
    yield {"type": "message_stop"}


def chat_events(tool, arguments):
    envelope = {"id": "chatcmpl_fixture", "object": "chat.completion.chunk",
                "created": 0, "model": MODEL}
    yield {**envelope, "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]}
    if tool:
        delta = {"tool_calls": [{"index": 0, "id": "call_fixture", "type": "function",
                               "function": {"name": tool, "arguments": json.dumps(arguments)}}]}
    else:
        delta = {"content": "Finished the requested edit."}
    yield {**envelope, "choices": [{"index": 0, "delta": delta, "finish_reason": None}]}
    yield {**envelope, "choices": [{"index": 0, "delta": {},
                                   "finish_reason": "tool_calls" if tool else "stop"}]}
    yield {**envelope, "choices": [], "usage": {
        "prompt_tokens": 32, "completion_tokens": 12, "total_tokens": 44,
    }}


class Replay(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        parts = self.path.split("?", 1)[0].strip("/").split("/")
        if len(parts) < 3 or parts[1] != "v1":
            self.send_error(404)
            return
        run_id, endpoint = parts[0], "/".join(parts[2:])
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if endpoint == "messages/count_tokens":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"input_tokens":32}')
            return
        if endpoint not in {"messages", "chat/completions"}:
            self.send_error(404)
            return

        tools = {tool["name"].lower(): tool for raw in request.get("tools", [])
                 if "name" in (tool := raw.get("function", raw))}
        receipts = self.server.receipts[run_id]
        rounds = [receipt["action"] for receipt in receipts if receipt["action"] != "auxiliary"]
        action = ("read", "edit", "finish")[min(len(rounds), 2)] if "read" in tools and "edit" in tools else "auxiliary"
        tool_name = None
        arguments = {}
        if action in {"read", "edit"}:
            tool = tools[action]
            tool_name = tool["name"]
            properties = tool.get("input_schema", tool.get("parameters", {})).get("properties", {})
            filename = str(self.server.trials / run_id / "worktree" / "metrics.py")
            path_parameter = "filePath" if "filePath" in properties else "file_path"
            arguments = {path_parameter: filename}
            if action == "edit":
                update = {"oldString": OLD, "newString": NEW, "replaceAll": False} if "oldString" in properties else {
                    "old_string": OLD, "new_string": NEW, "replace_all": False,
                }
                arguments.update({key: value for key, value in update.items() if key in properties})
        receipts.append({"protocol": endpoint, "action": action})
        self.send_response(200)
        if not request.get("stream") and endpoint == "messages":
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "id": "msg_fixture_aux", "type": "message", "role": "assistant", "model": MODEL,
                "content": [{"type": "text", "text": "Repair verified metrics"}],
                "stop_reason": "end_turn", "stop_sequence": None,
                "usage": {"input_tokens": 32, "output_tokens": 12},
            }).encode())
            return
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        if endpoint == "messages":
            for event in message_events(tool_name, arguments):
                self.wfile.write(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n".encode())
        else:
            for event in chat_events(tool_name, arguments):
                self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")


def agent_config(name, exe, url):
    if name in FUTURE_ARMS:
        argv = ["--bare", "--print", "--output-format", "json", "--no-session-persistence",
                "--permission-mode", "acceptEdits", "--model", MODEL, "{prompt_text}"]
        env = {"FUTURE_BASE_URL": url, "FUTURE_API_KEY": "replay-key",
               "FUTURE_CONFIG_DIR": "{result_dir}/future-state"}
    elif name == "claude-code":
        argv = ["--bare", "--print", "--output-format", "json", "--no-session-persistence",
                "--permission-mode", "acceptEdits", "--model", MODEL, "{prompt_text}"]
        env = {"ANTHROPIC_BASE_URL": url, "ANTHROPIC_API_KEY": "replay-key",
               "CLAUDE_CONFIG_DIR": "{result_dir}/claude-state",
               "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"}
    elif name == "opencode":
        argv = ["run", "--pure", "--format", "json", "--model", "fixture/" + MODEL,
                "--dir", "{workspace}", "{prompt_text}"]
        env = {"OPENCODE_CONFIG_CONTENT": json.dumps({
            "provider": {"fixture": {"npm": "@ai-sdk/openai-compatible", "name": "Fixture",
                "options": {"baseURL": url + "/v1", "apiKey": "replay-key"},
                "models": {MODEL: {"name": "Fixture", "limit": {"context": 8192, "output": 1024}}}}},
            "permission": {"read": "allow", "edit": "allow", "external_directory": "deny"},
        }), "OPENCODE_DISABLE_AUTOUPDATE": "true", "OPENCODE_DISABLE_MODELS_FETCH": "true",
            "XDG_DATA_HOME": "{result_dir}/data", "XDG_CONFIG_HOME": "{result_dir}/config",
            "XDG_STATE_HOME": "{result_dir}/state", "XDG_CACHE_HOME": "{result_dir}/cache"}
    else:
        raise ValueError(f"unknown replay agent: {name}")
    return {"name": name, "argv": [str(exe), *argv], "model": "scripted-provider",
            "version": subprocess.check_output([str(exe), "--version"], text=True, timeout=15).strip(),
            "env": env}


def sha_file(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent", action="append", required=True, metavar="NAME=EXECUTABLE")
    parser.add_argument("--repetitions", type=int, default=5, choices=range(1, 21), metavar="1..20")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    root = args.out.resolve()
    executables = {name: Path(path).resolve() for name, path in (arg.split("=", 1) for arg in args.agent)}
    if len(executables) != len(args.agent) or len(executables) < 2:
        parser.error("at least two distinct replay agents are required")
    root.mkdir()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Replay)
    server.trials = root / "trials"
    server.receipts = defaultdict(list)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        subprocess.run(["node", str(ROOT / "scripts/prepare-agent-comparison-fixture.mjs"),
                        "--out", str(root / "fixture")], check=True, stdout=subprocess.DEVNULL)
        config_file = root / "fixture/config.json"
        config = json.loads(config_file.read_text())
        config["mode"] = "offline-fixture"
        config["repetitions"] = args.repetitions
        config["cases"] = [dict(task, timeoutMs=30000) for task in config["cases"] if task["id"] == "metrics-fidelity"]
        url = f"http://127.0.0.1:{server.server_port}/{{run_id}}"
        config["agents"] = [agent_config(name, exe, url) for name, exe in executables.items()]
        config_file.write_text(json.dumps(config, indent=2) + "\n")
        run = subprocess.run(["node", str(ROOT / "scripts/compare-agent-productivity.mjs"),
                              "--config", str(config_file), "--out", str(server.trials)],
                             env={**os.environ, "NO_PROXY": "127.0.0.1,localhost",
                                  "no_proxy": "127.0.0.1,localhost"})
        if run.returncode not in {0, 2}:
            raise RuntimeError("comparison runner did not finish")
    finally:
        server.shutdown()
        thread.join()
        server.server_close()
    report = json.loads((server.trials / "report.json").read_text())
    report["comparison"] = "scripted repository-edit replay, zero live model calls"
    report["replaySha256"] = sha_file(Path(__file__))
    report["runnerSha256"] = sha_file(ROOT / "scripts/compare-agent-productivity.mjs")
    report["checkerSha256"] = sha_file(ROOT / "examples/agent-comparison/research_check.py")
    report["fixtureTree"] = subprocess.check_output(
        ["git", "-C", config["repository"], "rev-parse", "HEAD^{tree}"], text=True).strip()
    report["executableSha256"] = {name: sha_file(path) for name, path in executables.items()}
    patch_hashes = set()
    for trial in report["trials"]:
        trial["providerRequests"] = server.receipts.get(trial["runId"], [])
        stderr = (server.trials / trial["runId"] / "agent.stderr.log")
        if stderr.exists() and "option creation failed due to '-d2e'" in stderr.read_text():
            trial["startupFailure"] = "LEGACY_SHORT_FLAG_REGISTRATION"
        if trial["status"] == "PASS":
            actions = [receipt["action"] for receipt in trial["providerRequests"] if receipt["action"] != "auxiliary"]
            if trial["checkExitCode"] != 0 or actions != ["read", "edit", "finish"]:
                raise RuntimeError(f"passing trial did not exercise the scripted tool flow: {trial['runId']}")
            patch_hashes.add(trial["patchHash"])
    if len(patch_hashes) > 1:
        raise RuntimeError("successful replay edits differ across trials")
    evidence = root / "evidence.json"
    evidence.write_text(json.dumps(report, indent=2) + "\n")
    print(evidence)


if __name__ == "__main__":
    main()
