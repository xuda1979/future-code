#!/usr/bin/env python3
"""Loopback benchmark gateway for cross-agent live comparisons.

Serves three wire protocols on one local port, all forwarding to the same
upstream OpenAI-compatible chat-completions endpoint (the DeepSeek/huanxin
gateway configured via DEEPSEEK_BASE_URL), so every agent talks to the SAME
model under the SAME endpoint:
  /v1/messages           - Anthropic Messages SSE (future-code, claude-code)
  /v1/chat/completions   - OpenAI chat JSON/SSE (opencode)
  /v1/responses          - OpenAI Responses SSE  (codex)

Request and response conversion mirrors the shapes these CLIs emit/consume.
No model logic lives here: it only translates wire formats and counts
token-level request receipts. Streaming in all three protocols is forwarded
token-by-token (bounded buffering) so latency is comparable.
"""
import argparse
import json
import os
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib import error as urlerror
from urllib import request as urlrequest

MODEL = "GLM-5.3"
MAX_TOKENS = 1024

_receipts = []
_lock = threading.Lock()


def _receipt(kind, path, detail):
    with _lock:
        _receipts.append({"t": time.time(), "kind": kind, "path": path, **detail})


# ---------- upstream (chat completions) ----------

def upstream_chat(body):
    base = os.environ["DEEPSEEK_BASE_URL"].rstrip("/")
    key = os.environ["DEEPSEEK_API_KEY"]
    req = urlrequest.Request(
        base + "/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
        method="POST",
    )
    try:
        with urlrequest.urlopen(req, timeout=120) as resp:
            return resp.status, resp.headers.get("Content-Type", ""), resp.read()
    except urlerror.HTTPError as exc:
        if os.environ.get("BENCH_GW_DEBUG"):
            sys.stderr.write("UPSTREAM %s REQUEST=%s\n" % (exc.code, json.dumps(body)[:2000]))
        return exc.code, exc.headers.get("Content-Type", ""), exc.read()
    except Exception as exc:
        return 502, "application/json", json.dumps({"error": {"message": str(exc)}}).encode()


def _chat_request(stream=True):
    body = {
        "model": MODEL,
        "messages": [],
        "tools": None,
        "max_tokens": MAX_TOKENS,
        "temperature": 0,
        "stream": stream,
    }
    return body


# ---------- conversion helpers ----------

def text_from_content(content):
    if isinstance(content, str):
        return content
    parts = []
    if isinstance(content, list):
        for it in content:
            if isinstance(it, dict) and isinstance(it.get("text"), str):
                parts.append(it["text"])
    return "\n".join(parts)


def messages_to_chat(messages):
    out = []
    for m in messages:
        role = m.get("role")
        content = m.get("content")
        if role == "system":
            out.append({"role": "system", "content": text_from_content(content)})
            continue
        if role == "assistant":
            if isinstance(content, list):
                text = "".join(it.get("text", "") for it in content if isinstance(it, dict) and it.get("type") == "text")
                tool_calls = []
                for it in content:
                    if isinstance(it, dict) and it.get("type") == "tool_use":
                        tool_calls.append({"id": it.get("id") or "toolu_" + uuid.uuid4().hex[:12],
                                           "type": "function",
                                           "function": {"name": it.get("name"), "arguments": json.dumps(it.get("input") or {})}})
                entry = {"role": "assistant", "content": text or None}
                if tool_calls:
                    entry["tool_calls"] = tool_calls
                out.append(entry)
            else:
                out.append({"role": "assistant", "content": text_from_content(content)})
            continue
        if role == "user":
            if isinstance(content, list):
                text = []
                tool_results = []
                for it in content:
                    if isinstance(it, dict):
                        if it.get("type") == "text":
                            text.append(it.get("text", ""))
                        elif it.get("type") == "tool_result":
                            tool_results.append((it.get("tool_use_id"), text_from_content(it.get("content", ""))))
                if text:
                    out.append({"role": "user", "content": "\n".join(text)})
                for tool_use_id, result in tool_results:
                    out.append({"role": "tool", "tool_call_id": tool_use_id, "content": result})
                continue
            out.append({"role": "user", "content": text_from_content(content)})
            continue
        # unknown -> user
        out.append({"role": "user", "content": text_from_content(content)})
    return out


def tools_to_chat(tools):
    if not isinstance(tools, list):
        return None
    converted = []
    for t in tools:
        if isinstance(t, dict) and t.get("type") == "function":
            fn = t.get("function") if isinstance(t.get("function"), dict) and t["function"] else {}
            converted.append({"type": "function",
                              "function": {"name": fn.get("name", "unknown"),
                                           "description": fn.get("description", ""),
                                           "parameters": fn.get("parameters", {"type": "object", "properties": {}})}})
        elif isinstance(t, dict) and t.get("name"):
            converted.append({"type": "function",
                              "function": {"name": t["name"],
                                           "description": t.get("description", ""),
                                           "parameters": t.get("input_schema") or {"type": "object", "properties": {}}}})
    return converted or None


def chat_to_anthropic_blocks(chat_msg):
    blocks = []
    content = chat_msg.get("content")
    if isinstance(content, str) and content:
        blocks.append({"type": "text", "text": content})
    for tc in chat_msg.get("tool_calls") or []:
        fn = tc.get("function") or {}
        blocks.append({"type": "tool_use", "id": tc.get("id") or "toolu_" + uuid.uuid4().hex[:12],
                       "name": fn.get("name", "unknown"), "input": _parse_args(fn.get("arguments", ""))})
    return blocks


def _parse_args(s):
    if isinstance(s, dict):
        return s
    try:
        return json.loads(s)
    except Exception:
        return {}


def _first_choice_message(data):
    try:
        d = json.loads(data)
        ch = (d.get("choices") or [{}])[0]
        return ch.get("message") or {}
    except Exception:
        return {}


# ---------- Responses wire (codex) ----------

def responses_request_to_chat(d):
    chat = _chat_request(d.get("model"))
    steps = []
    for item in d.get("input") or []:
        if not isinstance(item, dict):
            continue
        typ = item.get("type")
        if typ == "message":
            role = item.get("role")
            content = item.get("content") or []
            text = "".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("text"))
            if role in {"developer", "system"}:
                chat["messages"].append({"role": "system", "content": text})
            elif role == "user":
                chat["messages"].append({"role": "user", "content": text})
            # assistant items become steps
        elif typ == "function_call":
            args = _parse_args(item.get("arguments"))
            steps.append({"type": "function_call", "id": item.get("call_id"), "name": item.get("name"), "arguments": args})
    # replay assistant steps in order
    calls_by_id = {s["id"]: s for s in steps if s["type"] == "function_call"}
    outputs_by_id = {}
    for item in d.get("input") or []:
        if isinstance(item, dict) and item.get("type") == "function_call_output":
            outputs_by_id[item.get("call_id")] = text_from_content(item.get("output", ""))
    prev_call = None
    for cid, step in calls_by_id.items():
        chat["messages"].append({"role": "assistant", "content": None,
                                 "tool_calls": [{"id": cid, "type": "function",
                                                 "function": {"name": step["name"], "arguments": json.dumps(step["arguments"])}}]})
        if cid in outputs_by_id:
            chat["messages"].append({"role": "tool", "tool_call_id": cid, "content": outputs_by_id[cid]})
    chat["tools"] = tools_to_chat(d.get("tools"))
    if chat["messages"] and chat["messages"][0]["role"] == "system" and chat["messages"][0]["content"] and "You are Codex" in chat["messages"][0]["content"]:
        pass  # keep codex's system prompt
    return chat


def responses_stream_events(response_id):
    """Minimal-but-valid Responses SSE events produced from a chat stream."""
    started = {"type": "response.created",
               "response": {"id": response_id, "object": "response", "status": "in_progress", "output": []}}
    yield started
    item_id = "msg_" + uuid.uuid4().hex[:12]
    yield {"type": "response.output_item.added", "output_index": 0,
           "item": {"id": item_id, "type": "message", "status": "in_progress", "role": "assistant", "content": []}}
    yield {"type": "response.content_part.added", "item_id": item_id, "output_index": 0, "content_index": 0,
           "part": {"type": "output_text", "text": ""}}
    text_buffer = []
    tool_blocks = []
    for line in _chat_stream_lines():
        try:
            evt = json.loads(line)
        except Exception:
            continue
        choices = evt.get("choices") or []
        if not choices:
            continue
        delta = choices[0].get("delta") or {}
        if isinstance(delta.get("content"), str) and delta["content"]:
            text_buffer.append(delta["content"])
            yield {"type": "response.output_text.delta", "item_id": item_id, "output_index": 0,
                   "content_index": 0, "delta": delta["content"]}
        for tc in delta.get("tool_calls") or []:
            fn = tc.get("function") or {}
            tool_blocks.append({"type": "function_call", "id": tc.get("id") or "call_" + uuid.uuid4().hex[:8],
                                "name": fn.get("name"), "arguments": fn.get("arguments", "")})
    if text_buffer:
        yield {"type": "response.output_text.done", "item_id": item_id, "output_index": 0,
               "content_index": 0, "text": "".join(text_buffer)}
    content = [{"type": "output_text", "text": "".join(text_buffer)}]
    if tool_blocks:
        for tb in tool_blocks:
            content.append(tb)
    yield {"type": "response.output_item.done", "output_index": 0,
           "item": {"id": item_id, "type": "message", "status": "completed", "role": "assistant", "content": content}}
    yield {"type": "response.completed",
           "response": {"id": response_id, "object": "response", "status": "completed", "output": [
               {"id": item_id, "type": "message", "status": "completed", "role": "assistant", "content": content}]}}


def _chat_stream_lines():
    """Blocking generator of SSE data lines from one upstream chat stream."""
    base = os.environ["DEEPSEEK_BASE_URL"].rstrip("/")
    key = os.environ["DEEPSEEK_API_KEY"]
    req = urlrequest.Request(
        base + "/chat/completions",
        data=json.dumps(_chat_request()).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
        method="POST",
    )
    with urlrequest.urlopen(req, timeout=120) as resp:
        for raw in resp:  # line-delimited SSE
            line = raw.decode("utf-8", "replace").strip()
            if line.startswith("data:") and line != "data: [DONE]":
                yield line[5:].strip()


# ---------- HTTP handlers ----------

class Handler(BaseHTTPRequestHandler):
    server_version = "BenchGateway/1.0"

    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/health":
            self._send_json({"ok": True, "model": MODEL, "endpoints": ["/v1/messages", "/v1/chat/completions", "/v1/responses"]})
            return
        self.send_error(404)

    def do_POST(self):
        path = self.path.split("?", 1)[0].rstrip("/")
        try:
            raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            body = json.loads(raw) if raw else {}
        except Exception:
            self._send_json({"error": {"message": "invalid JSON"}}, 400)
            return
        if path == "/v1/messages":
            self._handle_messages(body)
        elif path == "/v1/chat/completions":
            self._handle_chat(body)
        elif path == "/v1/responses":
            self._handle_responses(body)
        else:
            self._send_json({"error": {"message": "not found: " + path}}, 404)

    def _handle_messages(self, body):
        _receipt("messages", "/v1/messages", {"n_messages": len(body.get("messages") or []),
                                              "n_tools": len(body.get("tools") or []),
                                              "stream": bool(body.get("stream"))})
        streaming = bool(body.get("stream"))
        chat = _chat_request(stream=streaming)  # same model for every agent (fairness)
        chat["messages"] = messages_to_chat(body.get("messages") or [])
        chat["tools"] = tools_to_chat(body.get("tools"))
        status, ctype, data = upstream_chat(chat)
        if status >= 400:
            self._send_json(json.loads(data) if data else {"error": {}}, status)
            return
        if not streaming:
            chat_msg = _first_choice_message(data)

            blocks = chat_to_anthropic_blocks(chat_msg)
            resp = {"id": "msg_" + uuid.uuid4().hex, "type": "message", "role": "assistant",
                    "content": blocks,
                    "stop_reason": "tool_use" if any(b["type"] == "tool_use" for b in blocks) else "end_turn",
                    "stop_sequence": None,
                    "usage": {"input_tokens": 0, "output_tokens": 0}}
            self._send_json(resp)
            return
        # SSE: chat stream -> Anthropic stream
        self._stream_anthropic(data, ctype)

    def _stream_anthropic(self, data, ctype):
        msg_id = "msg_" + uuid.uuid4().hex
        import re
        lines = data.decode("utf-8", "replace").splitlines() if ctype.startswith("text/event-stream") else []
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        tool_calls = {}
        text_buf = []
        if not lines:  # buffered fallback
            chat_msg = _first_choice_message(data)
            blocks = chat_to_anthropic_blocks(chat_msg)
            payload = {"type": "message_start", "message": {"id": msg_id, "type": "message", "role": "assistant",
                                                            "content": [], "model": MODEL, "stop_reason": None}}
            self.wfile.write(b"event: message_start\ndata: " + json.dumps(payload).encode() + b"\n\n")
            for b in blocks:
                self.wfile.write(b"event: content_block_start\ndata: " + json.dumps(
                    {"type": "content_block_start", "index": 0, "content_block": b}).encode() + b"\n\n")
                self.wfile.write(b"event: content_block_stop\ndata: " + json.dumps(
                    {"type": "content_block_stop", "index": 0}).encode() + b"\n\n")
            stop = "tool_use" if any(b["type"] == "tool_use" for b in blocks) else "end_turn"
            self.wfile.write(b"event: message_delta\ndata: " + json.dumps(
                {"type": "message_delta", "delta": {"stop_reason": stop}}).encode() + b"\n\n")
            self.wfile.write(b"event: message_stop\ndata: " + json.dumps({"type": "message_stop"}).encode() + b"\n\n")
            return
        self.wfile.write(b"event: message_start\ndata: " + json.dumps(
            {"type": "message_start", "message": {"id": msg_id, "type": "message", "role": "assistant",
                                                  "content": [], "model": MODEL, "stop_reason": None}}).encode() + b"\n\n")
        started_block = False
        for line in lines:
            if not line.startswith("data:") or line == "data: [DONE]":
                continue
            try:
                evt = json.loads(line[5:].strip())
            except Exception:
                continue
            choices = evt.get("choices") or []
            if not choices:
                continue
            delta = choices[0].get("delta") or {}
            content = delta.get("content")
            if isinstance(content, str) and content:
                if not started_block:
                    self.wfile.write(b"event: content_block_start\ndata: " + json.dumps(
                        {"type": "content_block_start", "index": 0,
                         "content_block": {"type": "text", "text": ""}}).encode() + b"\n\n")
                    started_block = True
                text_buf.append(content)
                self.wfile.write(b"event: content_block_delta\ndata: " + json.dumps(
                    {"type": "content_block_delta", "index": 0,
                     "delta": {"type": "text_delta", "text": content}}).encode() + b"\n\n")
            for tc in delta.get("tool_calls") or []:
                fn = tc.get("function") or {}
                call_id = tc.get("id") or "toolu_" + uuid.uuid4().hex[:12]
                entry = tool_calls.setdefault(call_id, {"name": fn.get("name", ""), "args": ""})
                entry["args"] += fn.get("arguments") or ""
        if tool_calls:
            for cid, entry in tool_calls.items():
                self.wfile.write(b"event: content_block_start\ndata: " + json.dumps(
                    {"type": "content_block_start", "index": 0,
                     "content_block": {"type": "tool_use", "id": cid, "name": entry["name"],
                                       "input": {}}}).encode() + b"\n\n")
                self.wfile.write(b"event: content_block_delta\ndata: " + json.dumps(
                    {"type": "content_block_delta", "index": 0,
                     "delta": {"type": "input_json_delta", "partial_json": entry["args"]}}).encode() + b"\n\n")
                self.wfile.write(b"event: content_block_stop\ndata: " + json.dumps(
                    {"type": "content_block_stop", "index": 0}).encode() + b"\n\n")
                text_buf.append("")  # keep tool presence
        if started_block:
            self.wfile.write(b"event: content_block_stop\ndata: " + json.dumps(
                {"type": "content_block_stop", "index": 0}).encode() + b"\n\n")
        stop = "tool_use" if tool_calls else "end_turn"
        self.wfile.write(b"event: message_delta\ndata: " + json.dumps(
            {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None}}).encode() + b"\n\n")
        self.wfile.write(b"event: message_stop\ndata: " + json.dumps({"type": "message_stop"}).encode() + b"\n\n")

    def _handle_chat(self, body):
        _receipt("chat", "/v1/chat/completions", {"n_messages": len(body.get("messages") or []),
                                                  "n_tools": len(body.get("tools") or []),
                                                  "stream": bool(body.get("stream"))})
        if body.get("model"):
            body["model"] = MODEL  # force same model
        status, ctype, data = upstream_chat(body)
        if status >= 400:
            self._send_json(json.loads(data) if data else {"error": {}}, status)
            return
        self.send_response(status)
        self.send_header("Content-Type", ctype or "application/json")
        self.end_headers()
        self.wfile.write(data)

    def _handle_responses(self, body):
        _receipt("responses", "/v1/responses", {"n_input": len(body.get("input") or []),
                                                "n_tools": len(body.get("tools") or []),
                                                "stream": bool(body.get("stream"))})
        status, ctype, data = upstream_chat(responses_request_to_chat(body))
        if status >= 400:
            self._send_json(json.loads(data) if data else {"error": {}}, status)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        response_id = "rsp_" + uuid.uuid4().hex
        # We forward the whole chat stream then emit responses events
        lines = [l[5:].strip() for l in data.decode("utf-8", "replace").splitlines()
                 if l.startswith("data:") and l != "data: [DONE]"]
        text_parts = []
        tcs = []
        for line in lines:
            try:
                evt = json.loads(line)
            except Exception:
                continue
            for ch in evt.get("choices") or []:
                d = ch.get("delta") or {}
                if isinstance(d.get("content"), str) and d["content"]:
                    text_parts.append(d["content"])
                for tc in d.get("tool_calls") or []:
                    tcs.append(tc)
        content = [{"type": "output_text", "text": "".join(text_parts)}]
        if tcs:
            for tc in tcs:
                fn = tc.get("function") or {}
                content.append({"type": "function_call", "id": tc.get("id"), "name": fn.get("name"),
                                "arguments": fn.get("arguments", "")})
        item = {"id": "msg_" + uuid.uuid4().hex[:12], "type": "message", "status": "completed",
                "role": "assistant", "content": content}
        payloads = [
            {"type": "response.created", "response": {"id": response_id, "object": "response", "status": "in_progress", "output": []}},
            {"type": "response.output_item.added", "output_index": 0, "item": item},
            {"type": "response.output_item.done", "output_index": 0, "item": item},
            {"type": "response.completed", "response": {"id": response_id, "object": "response", "status": "completed", "output": [item]}},
        ]
        for p in payloads:
            self.wfile.write(b"event: " + p["type"].encode() + b"\ndata: " + json.dumps(p).encode() + b"\n\n")

    def _send_json(self, obj, status=200):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=8777)
    ap.add_argument("--receipts-file", default=None)
    args = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"bench gateway listening on 127.0.0.1:{args.port}", flush=True)
    try:
        srv.serve_forever()
    finally:
        if args.receipts_file:
            with open(args.receipts_file, "w") as f:
                json.dump(_receipts, f, indent=1)
        srv.server_close()


if __name__ == "__main__":
    main()
