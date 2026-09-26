import asyncio
from datetime import datetime, timezone
from email.utils import format_datetime
import json
import random
import time
from pathlib import Path
import sys
import httpx
import pytest

from future_code.contracts import BudgetExceeded, ContractError, Endpoint
from future_code.transport import CommandBackend, HTTPBackend, PermanentEndpointError, TemporaryEndpointError, retry_after_seconds

MESSAGES = [{"role": "user", "content": "Return a JSON action"}]


def envelope(content='{"action":"finish","summary":"done","uncertainties":[]}', **kwargs):
    return {"choices": [{"message": {"content": content}, "finish_reason": "stop"}], "usage": {"total_tokens": 12}, **kwargs}


def make(config, db, handler):
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return HTTPBackend(config, db, client=client, rng=random.Random(0)), client


async def test_success_auth_usage_and_secret_not_logged(config, db, monkeypatch):
    monkeypatch.setenv("FUTURE_CODE_API_KEY", "LOCAL_TEST_TOKEN_ONLY")
    config.endpoint.headers_env = {"X-Ca-Key": "TEST_APPCODE"}
    monkeypatch.setenv("TEST_APPCODE", "TEST_APP_CODE")
    def handler(request):
        assert request.headers["Authorization"] == "Bearer LOCAL_TEST_TOKEN_ONLY"
        assert request.headers["X-Ca-Key"] == "TEST_APP_CODE"
        body = json.loads(request.content)
        assert body["stream"] is False and body["model"] == config.endpoint.model
        return httpx.Response(200, json=envelope())
    backend, client = make(config, db, handler)
    async with client:
        assert json.loads(await backend.complete(MESSAGES, "a"))["action"] == "finish"
    assert db.rows("SELECT state FROM connections")[0]["state"] == "READY"
    assert db.rows("SELECT actual_tokens FROM reservations")[0]["actual_tokens"] == 12
    assert "LOCAL_TEST_TOKEN_ONLY" not in json.dumps(db.rows("SELECT * FROM events"))


@pytest.mark.parametrize("status", [408, 425, 429, 500, 502, 503, 504])
async def test_transient_statuses_cool_down(config, db, status):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(status, headers={"Retry-After": "2"})
    backend, client = make(config, db, handler)
    async with client:
        with pytest.raises(TemporaryEndpointError) as error:
            await backend.complete(MESSAGES, "a")
        assert error.value.retry_after >= 2
        with pytest.raises(TemporaryEndpointError):
            await backend.complete(MESSAGES, "a")
    assert len(calls) == 1
    assert db.conn.execute("SELECT COUNT(*) FROM reservations").fetchone()[0] == 1


@pytest.mark.parametrize("status", [400, 401, 403, 404, 422, 302])
async def test_permanent_statuses_are_not_auto_retried(config, db, status):
    backend, client = make(config, db, lambda request: httpx.Response(status))
    async with client:
        with pytest.raises(PermanentEndpointError):
            await backend.complete(MESSAGES, "a")
    assert db.conn.execute("SELECT COUNT(*) FROM reservations").fetchone()[0] == 1


async def test_circuit_half_open_allows_single_probe(config, db):
    config.circuit_failures = 1
    started = asyncio.Event(); release = asyncio.Event(); calls = 0
    async def handler(request):
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(503)
        started.set()
        await release.wait()
        return httpx.Response(200, json=envelope())
    backend, client = make(config, db, handler)
    async with client:
        with pytest.raises(TemporaryEndpointError):
            await backend.complete(MESSAGES, "a")
        assert backend.open
        backend.retry_at = 0
        first = asyncio.create_task(backend.complete(MESSAGES, "a"))
        await started.wait()
        with pytest.raises(TemporaryEndpointError):
            await backend.complete(MESSAGES, "b")
        release.set()
        await first
    assert calls == 2 and not backend.open
    assert db.rows("SELECT state FROM connections")[0]["state"] == "READY"


async def test_timeout_and_tls_failure(config, db):
    config.endpoint.request_timeout = 0.03
    async def hung(request):
        await asyncio.sleep(10)
        return httpx.Response(200, json=envelope())
    backend, client = make(config, db, hung)
    async with client:
        with pytest.raises(TemporaryEndpointError):
            await backend.complete(MESSAGES, "a")
    def tls(request):
        raise httpx.ConnectError("CERTIFICATE_VERIFY_FAILED", request=request)
    backend, client = make(config, db, tls)
    backend.retry_at = 0
    async with client:
        with pytest.raises(PermanentEndpointError, match="TLS"):
            await backend.complete(MESSAGES, "a")
    assert db.rows("SELECT state FROM connections")[0]["state"] == "TLS_ERROR"


@pytest.mark.parametrize("body", [{}, {"choices": []}, {"choices": [{"message": {"content": ""}}]}, {"choices": [{"message": {"content": []}}]}])
async def test_malformed_envelope_cannot_pass(config, db, body):
    backend, client = make(config, db, lambda request: httpx.Response(200, json=body))
    async with client:
        with pytest.raises(ContractError):
            await backend.complete(MESSAGES, "a")
    assert db.rows("SELECT state FROM connections")[0]["state"] != "READY"


async def test_response_size_and_missing_usage(config, db):
    config.max_response_bytes = 1024
    backend, client = make(config, db, lambda request: httpx.Response(200, content=b"x" * 1025))
    async with client:
        with pytest.raises(ContractError, match="byte limit"):
            await backend.complete(MESSAGES, "a")
    backend, client = make(config, db, lambda request: httpx.Response(200, json=envelope(usage=None)))
    async with client:
        await backend.complete(MESSAGES, "a")
    assert db.rows("SELECT actual_tokens FROM reservations ORDER BY created_at DESC LIMIT 1")[0]["actual_tokens"] is None


async def test_budget_prevents_network_request(config, db):
    config.max_requests = 1
    count = 0
    def handler(request):
        nonlocal count
        count += 1
        return httpx.Response(200, json=envelope())
    backend, client = make(config, db, handler)
    async with client:
        await backend.complete(MESSAGES, "a")
        with pytest.raises(BudgetExceeded):
            await backend.complete(MESSAGES, "a")
    assert count == 1


async def test_health_does_not_assert_inference_readiness(config, db):
    config.endpoint.health_url = "http://127.0.0.1:8090/health"
    backend, client = make(config, db, lambda request: httpx.Response(200, json={"status": "ok"}))
    async with client:
        await backend.probe()
        assert db.rows("SELECT state FROM connections")[0]["state"] == "REACHABLE"
        db.connection(config.endpoint.name, "AUTH_REQUIRED")
        await backend.probe()
        assert db.rows("SELECT state FROM connections")[0]["state"] == "AUTH_REQUIRED"
    assert db.conn.execute("SELECT COUNT(*) FROM reservations").fetchone()[0] == 0


def test_retry_after_http_date_and_invalid():
    assert retry_after_seconds("4") == 4
    assert retry_after_seconds("garbage") is None
    assert retry_after_seconds("-3") is None
    assert retry_after_seconds("9999999999") is None
    now = time.time()
    stamp = format_datetime(datetime.fromtimestamp(now + 60, timezone.utc), usegmt=True)
    assert 59 <= retry_after_seconds(stamp, now) <= 60


async def test_existing_cli_adapter_real_process(config, db, tmp_path):
    config.backend = "command"
    action = {"action": "finish", "summary": "CLI fixture", "uncertainties": []}
    payload = json.dumps({"result": json.dumps(action)})
    config.command_argv = [sys.executable, "-c", f"import sys; assert 'user' in sys.stdin.read(); print({payload!r})"]
    backend = CommandBackend(config, db)
    assert json.loads(await backend.complete(MESSAGES, "a", tmp_path)) == action
    config.command_argv = [sys.executable, "-c", "raise SystemExit(1)"]
    with pytest.raises(PermanentEndpointError):
        await backend.complete(MESSAGES, "a", tmp_path)
    await backend.close()
