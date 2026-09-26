"""Pooled, bounded HTTP completion transport and an opt-in existing-CLI adapter."""
from __future__ import annotations

import asyncio
from datetime import timezone
from email.utils import parsedate_to_datetime
import json
import os
from pathlib import Path
import random
import time
import uuid

import httpx

from .contracts import Config, ContractError, Endpoint
from .context import enforce_bounds
from .process import run_process
from .security import Redactor
from .store import Store


class TemporaryEndpointError(RuntimeError):
    def __init__(self, detail: str, retry_after: float):
        super().__init__(detail)
        self.retry_after = max(0.001, retry_after)


class PermanentEndpointError(RuntimeError):
    """Authentication, request or configuration failure; automatic repeats would not help."""


def retry_after_seconds(value: str | None, now: float | None = None) -> float | None:
    if not value:
        return None
    try:
        delay = float(value)
        if not 0 <= delay <= 86400:
            return None
        return delay
    except ValueError:
        try:
            dt = parsedate_to_datetime(value)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return max(0, min(86400, dt.timestamp() - (time.time() if now is None else now)))
        except (ValueError, TypeError, OverflowError):
            return None


class HTTPBackend:
    def __init__(self, config: Config, db: Store, endpoint: Endpoint | None = None,
                 *, client: httpx.AsyncClient | None = None, rng: random.Random | None = None):
        self.config, self.db = config, db
        self.endpoint = endpoint or config.endpoint
        e = self.endpoint
        self.client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(e.read_timeout, connect=e.connect_timeout, write=30, pool=10),
            limits=httpx.Limits(max_connections=config.max_workers + 4,
                                max_keepalive_connections=config.max_workers + 4, keepalive_expiry=30),
            follow_redirects=False, verify=True, trust_env=False)
        self.owns_client = client is None
        self.rng = rng or random.Random()
        old = db.rows("SELECT * FROM connections WHERE name=?", (e.name,))
        self.failures = old[0]["failures"] if old else 0
        self.retry_at = (old[0]["retry_at"] or 0) if old else 0
        self.open = bool(old and old[0]["state"] == "OPEN")
        self.half_open = False
        self.closed = False
        secrets = [os.environ.get(e.api_key_env, "")] + [os.environ.get(v, "") for v in e.headers_env.values()]
        self.redactor = Redactor(secrets)
        if not old:
            db.connection(e.name, "UNKNOWN", detail="No inference request has been verified")

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json", "Accept": "application/json", "X-Request-ID": uuid.uuid4().hex}
        key = os.environ.get(self.endpoint.api_key_env, "")
        if key:
            if "\r" in key or "\n" in key:
                raise PermanentEndpointError("Invalid newline in API credential")
            headers["Authorization"] = f"Bearer {key}"
        for name, env in self.endpoint.headers_env.items():
            value = os.environ.get(env)
            if value:
                if "\r" in value or "\n" in value:
                    raise PermanentEndpointError("Invalid newline in configured header value")
                headers[name] = value
        return headers

    def _admit(self) -> None:
        if self.closed:
            raise PermanentEndpointError("Transport is closed")
        now = time.time()
        if self.retry_at > now:
            raise TemporaryEndpointError("Endpoint cooling down; no request was sent", self.retry_at - now)
        if self.open:
            if self.half_open:
                raise TemporaryEndpointError("Another request owns the circuit recovery probe", self.config.retry_base_seconds)
            self.half_open = True
            self.db.connection(self.endpoint.name, "HALF_OPEN", failures=self.failures, detail="One inference recovery probe in flight")

    def _temporary(self, detail: str, server_delay: float | None = None) -> TemporaryEndpointError:
        self.failures += 1
        ceiling = min(self.config.retry_cap_seconds, self.config.retry_base_seconds * 2 ** min(20, self.failures - 1))
        delay = max(self.config.retry_base_seconds, self.rng.uniform(0, ceiling), server_delay or 0)
        self.retry_at = time.time() + delay
        self.open = self.failures >= self.config.circuit_failures
        self.db.connection(self.endpoint.name, "OPEN" if self.open else "DEGRADED", failures=self.failures,
                           retry_at=self.retry_at, detail=detail)
        return TemporaryEndpointError(detail, delay)

    async def complete(self, messages: list[dict], task_id: str, workspace: Path | None = None) -> str:
        enforce_bounds(messages, self.config)
        self._admit()
        # Conservative reservation, NOT a measured token count or a monetary cost estimate.
        prompt_bytes = len(json.dumps(messages, ensure_ascii=False).encode("utf-8"))
        try:
            reservation = self.db.reserve(task_id, prompt_bytes + self.config.max_output_tokens,
                                          max_requests=self.config.max_requests, max_tokens=self.config.max_reserved_tokens)
            payload = {"model": self.endpoint.model, "messages": messages, "stream": False,
                       "max_tokens": self.config.max_output_tokens, "temperature": 0.1}
            async with asyncio.timeout(self.endpoint.request_timeout):
                async with self.client.stream("POST", self.endpoint.url, headers=self._headers(), json=payload) as response:
                    status = response.status_code
                    if status in {408, 425, 429} or 500 <= status <= 599:
                        raise self._temporary(f"Upstream HTTP {status}; request outcome may be billable",
                                              retry_after_seconds(response.headers.get("retry-after")))
                    if status in {401, 403}:
                        self.db.connection(self.endpoint.name, "AUTH_REQUIRED", failures=self.failures,
                                           detail=f"Upstream HTTP {status}; update credentials and explicitly retry task")
                        raise PermanentEndpointError(f"Upstream HTTP {status}: authentication/authorization required")
                    if not 200 <= status < 300:
                        self.db.connection(self.endpoint.name, "REQUEST_REJECTED", detail=f"HTTP {status}; request was not retried")
                        raise PermanentEndpointError(f"Upstream HTTP {status}: configuration or request requires correction")
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > self.config.max_response_bytes:
                            raise ContractError("Upstream response exceeded the configured byte limit")
            try:
                obj = json.loads(body)
                content = obj["choices"][0]["message"]["content"]
                if not isinstance(content, str) or not content.strip():
                    raise ValueError("empty content")
                usage = obj.get("usage") or {}
                actual = usage.get("total_tokens")
                if type(actual) is not int or actual < 0:
                    actual = None
                self.db.record_usage(reservation, actual)
                if actual is not None and actual > prompt_bytes + self.config.max_output_tokens:
                    # Don't continue to rely on a violated reservation estimate.
                    self.db.conn.execute("UPDATE reservations SET tokens=? WHERE id=?", (actual, reservation))
                    self.db.issue("token_accounting", "Provider usage exceeded conservative reservation", task_id, "warning")
                if obj["choices"][0].get("finish_reason") == "length":
                    raise ContractError("Completion was truncated by token limit; reduce output or split the task")
            except (KeyError, IndexError, TypeError, ValueError) as e:
                self.db.connection(self.endpoint.name, "PROTOCOL_ERROR", detail="Malformed completion envelope")
                raise ContractError("Endpoint returned a malformed completion envelope") from e
            self.failures, self.retry_at, self.open = 0, 0, False
            self.db.connection(self.endpoint.name, "READY", success=True, detail="Inference response received; model claims remain unverified")
            return content
        except (httpx.TransportError, TimeoutError) as e:
            # TLS verification stays enabled. No automatic insecure fallback.
            if "CERTIFICATE_VERIFY_FAILED" in str(e):
                self.db.connection(self.endpoint.name, "TLS_ERROR", detail="TLS verification failed; repair trust/certificate")
                raise PermanentEndpointError("TLS certificate verification failed") from e
            raise self._temporary(f"{type(e).__name__}; no local tool action was accepted") from e
        finally:
            self.half_open = False

    async def probe(self) -> None:
        """Only a configured, same-origin, non-billable health route is probed."""
        if not self.endpoint.health_url or self.closed or self.retry_at > time.time():
            return
        try:
            async with asyncio.timeout(min(15, self.endpoint.request_timeout)):
                async with self.client.stream("GET", self.endpoint.health_url, headers=self._headers()) as response:
                    status = response.status_code
            if 200 <= status < 300:
                old = self.db.rows("SELECT state FROM connections WHERE name=?", (self.endpoint.name,))
                # A health GET proves reachability only; it cannot certify model inference or credentials.
                if old and old[0]["state"] not in {"AUTH_REQUIRED", "TLS_ERROR", "REQUEST_REJECTED", "OPEN"}:
                    self.db.connection(self.endpoint.name, "REACHABLE", failures=self.failures,
                                       detail="Health route reachable; inference readiness is separate")
            else:
                self.db.event("connection.probe", name=self.endpoint.name, verdict="UNKNOWN", http_status=status)
        except (httpx.TransportError, TimeoutError):
            self.db.event("connection.probe", name=self.endpoint.name, verdict="UNKNOWN", reason="health route unavailable")

    async def close(self) -> None:
        self.closed = True
        if self.owns_client:
            await self.client.aclose()


class CommandBackend:
    """Opt-in adapter for a user-installed CLI. This is NOT an OS sandbox.

A wrapper may return {"result": "<JSON action>"}; native JSON actions also work.
The model receives the full bounded request on stdin, never a shell-expanded argument.
"""
    def __init__(self, config: Config, db: Store):
        self.config, self.db = config, db
        self.endpoint = config.endpoint
        self.redactor = Redactor([os.environ.get(k, "") for k in config.command_env_allowlist])
        self.closed = False
        db.connection("command", "UNKNOWN", detail="External CLI not yet exercised")

    async def complete(self, messages: list[dict], task_id: str, workspace: Path | None = None) -> str:
        if self.closed or workspace is None:
            raise PermanentEndpointError("Command backend requires an open workspace")
        enforce_bounds(messages, self.config)
        text = json.dumps(messages, ensure_ascii=False)
        self.db.reserve(task_id, len(text.encode()) + self.config.max_output_tokens,
                        max_requests=self.config.max_requests, max_tokens=self.config.max_reserved_tokens)
        result = await run_process(self.config.command_argv, workspace, timeout=self.endpoint.request_timeout,
                                   input_text=text, allow_env=self.config.command_env_allowlist,
                                   max_output=self.config.max_response_bytes)
        if result.timed_out or result.returncode != 0 or result.output_truncated:
            self.db.connection("command", "ERROR", detail="CLI failed, timed out or exceeded output limit; manual retry required")
            raise PermanentEndpointError("Existing CLI did not finish cleanly; unknown external side effects are not replayed automatically")
        output = result.stdout.strip()
        try:
            obj = json.loads(output)
            if isinstance(obj, dict) and "result" in obj and "action" not in obj:
                output = obj["result"]
            if not isinstance(output, str):
                raise ValueError("result is not text")
        except (ValueError, TypeError) as e:
            raise ContractError("CLI must return one JSON action or a JSON result envelope") from e
        self.db.connection("command", "READY", success=True, detail="CLI execution succeeded; provider billing is not observable")
        return output

    async def probe(self) -> None:
        return

    async def close(self) -> None:
        self.closed = True
