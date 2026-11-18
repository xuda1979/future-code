#!/usr/bin/env python3
"""Run the pinned local-model repair trial with the real headless CLIs."""
import argparse
from collections import defaultdict
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import runpy
import subprocess
from threading import Thread

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CONTRACT = json.loads((HERE / "live-contract.json").read_text())
MODEL = CONTRACT["model"]["alias"]
AGENTS = ("candidate", "claude-code", "opencode")


class Gateway(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def forward(self):
        parts = self.path.strip("/").split("/", 1)
        if len(parts) != 2 or not parts[0].startswith("r") or not parts[1].startswith("v1/"):
            self.send_error(404)
            return
        run_id, endpoint = parts
        payload = None
        if self.command == "POST":
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if endpoint in {"v1/messages", "v1/chat/completions", "v1/responses"}:
                request.update(model=MODEL, temperature=CONTRACT["model"]["temperature"], top_p=1)
                limit_field = {"v1/messages": "max_tokens", "v1/chat/completions": "max_tokens",
                               "v1/responses": "max_output_tokens"}[endpoint]
                request.pop("max_completion_tokens", None)
                request[limit_field] = CONTRACT["model"]["outputTokensPerRequest"]
            payload = json.dumps(request)
        connection = http.client.HTTPConnection("127.0.0.1", self.server.upstream_port, timeout=95)
        receipt = {"endpoint": endpoint, "status": None, "completed": False}
        self.server.receipts[run_id].append(receipt)
        try:
            connection.request(self.command, "/" + endpoint, payload, {"Content-Type": "application/json"})
            upstream = connection.getresponse()
            receipt["status"] = upstream.status
            self.send_response(upstream.status)
            content_type = upstream.getheader("Content-Type", "application/json")
            self.send_header("Content-Type", content_type)
            self.end_headers()
            if content_type.startswith("text/event-stream"):
                for line in upstream:
                    self.wfile.write(line)
                    self.wfile.flush()
            else:
                self.wfile.write(upstream.read())
            receipt["completed"] = True
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            connection.close()

    do_GET = forward
    do_POST = forward


def sha_file(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--future-code", type=Path, required=True)
    parser.add_argument("--claude-code", type=Path, required=True)
    parser.add_argument("--opencode", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True, help="Loopback llama-server port")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    root = args.out.resolve()
    root.mkdir()
    executables = [args.future_code.resolve(), args.claude_code.resolve(), args.opencode.resolve()]
    server = ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
    server.upstream_port = args.port
    server.receipts = defaultdict(list)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        subprocess.run(["node", str(ROOT / "scripts/prepare-agent-comparison-fixture.mjs"),
                        "--out", str(root / "fixture")], check=True, stdout=subprocess.DEVNULL)
        config_file = root / "fixture/config.json"
        config = json.loads(config_file.read_text())
        config["repetitions"] = CONTRACT["repetitions"]
        assert CONTRACT["cases"] == [case["id"] for case in config["cases"]]
        for case in config["cases"]:
            case["timeoutMs"] = CONTRACT["maxAgentMs"]
        replay = runpy.run_path(str(ROOT / "scripts/bench-agent-cli-replay.py"))
        make_agent = replay["agent_config"]
        url = f"http://127.0.0.1:{server.server_port}/{{run_id}}"
        config["agents"] = []
        for name, executable in zip(AGENTS, executables, strict=True):
            agent = make_agent(name, executable, url)
            agent["model"] = MODEL
            agent["argv"] = [value.replace(replay["MODEL"], MODEL) for value in agent["argv"]]
            if name == "opencode":
                opencode = json.loads(agent["env"]["OPENCODE_CONFIG_CONTENT"].replace(replay["MODEL"], MODEL))
                opencode["permission"] = {"*": "deny", "read": "allow", "edit": "allow"}
                opencode["provider"]["fixture"]["models"][MODEL]["limit"]["context"] = CONTRACT["model"]["context"]
                agent["env"]["OPENCODE_CONFIG_CONTENT"] = json.dumps(opencode)
            else:
                i = agent["argv"].index("--model")
                agent["argv"][i:i] = ["--tools", "Read,Edit"]
            config["agents"].append(agent)
        config_file.write_text(json.dumps(config, indent=2) + "\n")
        run = subprocess.run(["node", str(ROOT / "scripts/compare-agent-productivity.mjs"),
                              "--config", str(config_file), "--out", str(root / "trials")],
                             env={**os.environ, "NO_PROXY": "127.0.0.1,localhost",
                                  "no_proxy": "127.0.0.1,localhost"})
        if run.returncode not in {0, 2}:
            raise RuntimeError("comparison runner did not finish")
    finally:
        server.shutdown()
        thread.join()
        server.server_close()
    report = json.loads((root / "trials/report.json").read_text())
    report["contractSha256"] = sha_file(HERE / "live-contract.json")
    report["gatewaySha256"] = sha_file(Path(__file__))
    report["checkerSha256"] = sha_file(ROOT / "examples/agent-comparison/research_check.py")
    report["runnerSha256"] = sha_file(ROOT / "scripts/compare-agent-productivity.mjs")
    report["fixtureTree"] = subprocess.check_output(
        ["git", "-C", config["repository"], "rev-parse", "HEAD^{tree}"], text=True).strip()
    report["executableSha256"] = {name: sha_file(path) for name, path in zip(AGENTS, executables, strict=True)}
    for row in report["trials"]:
        row["providerRequests"] = server.receipts.get(row["runId"], [])
        if row["status"] == "PASS" and not any(req["completed"] and req["status"] == 200
                and req["endpoint"] in {"v1/messages", "v1/chat/completions"} for req in row["providerRequests"]):
            raise RuntimeError(f"verified edit without a completed model response: {row['runId']}")
    evidence = root / "evidence.json"
    evidence.write_text(json.dumps(report, indent=2) + "\n")
    print(evidence)


if __name__ == "__main__":
    main()
