"""Read-only loopback dashboard and health/metrics endpoints."""
from __future__ import annotations

from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import json
from pathlib import Path
from urllib.parse import urlsplit

from .reporting import render_html, render_metrics, snapshot
from .store import Store


class DashboardHandler(BaseHTTPRequestHandler):
    server_version = "FutureControl/1.1"

    def __init__(self, *args, database: Path, token: str = "", **kwargs):
        self.database, self.token = database, token
        super().__init__(*args, **kwargs)

    def log_message(self, format: str, *args) -> None:
        # Do not log URLs, Authorization headers or arbitrary request strings.
        return

    def send_content(self, status: int, body: str, content_type: str) -> None:
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self) -> None:
        self.connection.settimeout(5)
        host = self.headers.get("Host", "").split(":")[0].lower()
        if host not in {"127.0.0.1", "localhost"}:
            self.send_content(403, '{"error":"loopback Host required"}', "application/json")
            return
        if self.token and not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + self.token):
            self.send_content(401, '{"error":"authentication required"}', "application/json")
            return
        path = urlsplit(self.path).path
        if path not in {"/", "/v1/status", "/metrics", "/health/live", "/health/ready"}:
            self.send_content(404, '{"error":"not found"}', "application/json")
            return
        try:
            with Store(self.database, readonly=True) as db:
                data = snapshot(db)
        except Exception:
            self.send_content(503, '{"state":"UNKNOWN","reason":"state database unavailable"}', "application/json")
            return
        if path == "/":
            self.send_content(200, render_html(data), "text/html; charset=utf-8")
        elif path == "/metrics":
            self.send_content(200, render_metrics(data), "text/plain; version=0.0.4; charset=utf-8")
        elif path.startswith("/health/"):
            state = data["system"][0]["state"]
            live = state not in {"UNKNOWN", "STOPPED", "STOPPING"}
            ready = live and state in {"IDLE", "RUNNING"}
            passing = live if path.endswith("/live") else ready
            body = {"state": state, "verdict": "PASS" if passing else "UNKNOWN", "scope": "supervisor readiness, not an LLM inference guarantee"}
            self.send_content(200 if passing else 503, json.dumps(body), "application/json")
        else:
            self.send_content(200, json.dumps(data, ensure_ascii=False), "application/json")


def make_server(database: Path, *, port: int = 8765, token: str = "") -> ThreadingHTTPServer:
    # Remote exposure requires an authenticated TLS reverse proxy, never an accidental 0.0.0.0 bind.
    server = ThreadingHTTPServer(("127.0.0.1", port), partial(DashboardHandler, database=database, token=token))
    server.daemon_threads = True
    return server
