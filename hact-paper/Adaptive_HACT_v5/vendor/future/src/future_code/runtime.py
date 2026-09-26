"""Long-lived supervisor. Idle and degraded states do not imply process exit."""
from __future__ import annotations

import asyncio
from pathlib import Path
import shutil
import time
from typing import Any, Callable
import uuid

from .contracts import BudgetExceeded, Config, ConflictError, ContractError, FencedError
from .reporting import snapshot, write_reports
from .security import ensure_control
from .store import Store, encode
from .transport import CommandBackend, HTTPBackend, PermanentEndpointError, TemporaryEndpointError
from .worker import Worker
from .workspace import digest, hygiene_scan, recover_integrations


class Supervisor:
    def __init__(self, root: Path, config: Config, *, backend: Any = None, reviewer: Any = None,
                 event_callback: Callable[[dict], None] | None = None):
        self.root, self.config = root.resolve(), config
        self.control = ensure_control(self.root)
        self.db = Store(self.control / "state.db")
        self.owner = "runtime-" + uuid.uuid4().hex
        self.backend = backend
        self.reviewer = reviewer
        self.integration_lock = asyncio.Lock()
        self.active: dict[str, tuple[dict, asyncio.Task]] = {}
        self.stop_event = asyncio.Event()
        self.event_callback = event_callback
        self.probes: set[asyncio.Task] = set()
        self.peak_workers = 0
        self.last_emitted = 0
        self.resource_blocked = False
        self._closed = False

    def stop(self) -> None:
        self.stop_event.set()

    def state(self) -> str:
        if self.stop_event.is_set():
            return "STOPPING"
        if self.db.get_meta("paused", False):
            return "PAUSED"
        if self.resource_blocked:
            return "WAITING_CAPACITY"
        if self.db.get_meta("budget_blocked", False):
            return "WAITING_BUDGET"
        if self.active:
            return "RUNNING"
        if any(r["status"] == "retry_wait" for r in self.db.tasks()):
            return "WAITING_EXTERNAL"
        if any(r["status"] == "blocked" for r in self.db.tasks()):
            return "WAITING_OPERATOR"
        if any(r["status"] in {"queued", "waiting"} for r in self.db.tasks()):
            return "WAITING_DEPENDENCY"
        return "IDLE"

    async def execute(self, claim: dict) -> None:
        worker = Worker(self.root, claim, self.config, self.db, self.backend, self.integration_lock, self.reviewer)
        task_id, fence = claim["id"], claim["fence"]
        try:
            async with asyncio.timeout(claim["spec"]["timeout_seconds"]):
                await worker.run()
        except asyncio.CancelledError:
            # Cancellation means stop work, not defeat shutdown or retain a live worker.
            try:
                self.db.assert_owner(task_id, fence)
                if self.config.backend == "command":
                    self.db.finish(task_id, fence, "blocked", error="Command interrupted; external side effects unknown. Inspect before explicit retry")
                else:
                    self.db.defer_transport(task_id, fence, "Worker stopped; checkpoint retained for safe resume", 0)
            except FencedError:
                pass
            raise
        except BaseException as error:
            if isinstance(error, (KeyboardInterrupt, SystemExit)):
                raise
            detail = worker.redactor.text(f"{type(error).__name__}: {error}")[:2000]
            pending = self.db.rows("SELECT id FROM integrations WHERE task_id=? AND status='prepared'", (task_id,))
            if pending:
                self.db.issue("commit_interrupted", detail, task_id, "critical")
                self.db.set_meta("paused", True)
                async with self.integration_lock:
                    recover_integrations(self.root, self.db, self.config)
                return
            try:
                self.db.assert_owner(task_id, fence)
            except FencedError:
                return
            if isinstance(error, TemporaryEndpointError):
                self.db.defer_transport(task_id, fence, detail, error.retry_after)
            elif isinstance(error, BudgetExceeded):
                self.db.set_meta("budget_blocked", True)
                self.db.issue("budget", detail, task_id, "warning")
                self.db.finish(task_id, fence, "blocked", error=detail)
            elif isinstance(error, PermanentEndpointError):
                self.db.issue("external_configuration", detail, task_id)
                self.db.finish(task_id, fence, "blocked", error=detail)
            elif isinstance(error, ConflictError):
                self.db.issue("source_conflict", detail, task_id, "warning")
                self.db.finish(task_id, fence, "retry_wait", error=detail, delay=self.config.retry_base_seconds)
            elif isinstance(error, TimeoutError):
                self.db.issue("task_timeout", "Task deadline exceeded; divide the task or revise its approved deadline", task_id)
                self.db.finish(task_id, fence, "blocked", error="Task deadline exceeded; decompose before retrying")
            elif isinstance(error, ContractError):
                self.db.issue("task_contract", detail, task_id)
                self.db.finish(task_id, fence, "blocked", error=detail)
            else:
                issue = self.db.issue("worker_error", detail, task_id)
                occurrences = self.db.rows("SELECT count FROM issues WHERE id=?", (issue,))[0]["count"]
                # One bounded recovery attempt; unchanged repeated programming faults become incidents.
                status = "retry_wait" if occurrences == 1 and self.config.backend == "http" else "blocked"
                self.db.finish(task_id, fence, status, error=detail, delay=self.config.retry_base_seconds)

    def _heartbeat(self) -> None:
        now = time.time()
        self.db.runtime_heartbeat(self.owner, self.state(), lease_seconds=self.config.lease_seconds)
        for task_id, (claim, future) in list(self.active.items()):
            if future.done():
                continue
            try:
                self.db.heartbeat(task_id, claim["fence"], lease_seconds=self.config.lease_seconds)
            except FencedError:
                future.cancel()
        free = shutil.disk_usage(self.root).free
        blocked = free < self.config.minimum_free_bytes
        if blocked and not self.resource_blocked:
            self.db.issue("disk_capacity", f"Free space below configured threshold {self.config.minimum_free_bytes} bytes", severity="critical")
            for _, future in self.active.values():
                future.cancel()
        if not blocked and self.resource_blocked:
            self.db.event("capacity.recovered")
        self.resource_blocked = blocked
        self.db.set_meta("capacity", {"free_bytes": free, "observed_at": now})
        self.db.recover_expired(retry_safe=self.config.backend == "http")

    def _emit(self) -> None:
        events = self.db.rows("SELECT seq,ts,kind,task_id,data FROM events WHERE seq>? ORDER BY seq", (self.last_emitted,))
        if events:
            self.last_emitted = events[-1]["seq"]
        if self.event_callback:
            important = {"task.done", "task.blocked", "task.failed", "task.delegated", "integration.recovered", "gate.not_passed"}
            for event in events:
                if event["kind"] in important:
                    # Fixed event envelope, not model narrative or concurrent worker stdout.
                    self.event_callback({"event": event["kind"], "task": event["task_id"], "sequence": event["seq"], "evidence": ".future-code/reports/status.json"})

    async def run(self, *, until_idle: bool = False) -> dict:
        acquired = False
        final_result: dict = {"peak_workers": 0, "task_states": {}}
        try:
            self.db.acquire_runtime(self.owner, lease_seconds=self.config.lease_seconds)
            acquired = True
            self.db.set_meta("stale_seconds", self.config.stale_seconds)
            self.db.set_meta("budget_limits", {"requests": self.config.max_requests, "tokens": self.config.max_reserved_tokens})
            self.db.set_meta("execution_policy", {"max_workers": self.config.max_workers,
                                                 "backend": self.config.backend,
                                                 "context_chars": self.config.max_context_chars,
                                                 "context_bytes": self.config.max_context_bytes,
                                                 "max_children": self.config.max_children,
                                                 "max_active_per_cell": self.config.max_active_per_cell,
                                                 "context_items": self.config.context_items,
                                                 "topology": "hierarchical-task-mesh; single-host durable scheduler",
                                                 "observed_at": time.time()})
            policy_hash = digest(encode(self.config.to_dict()).encode())
            if self.db.get_meta("policy_hash") != policy_hash:
                self.db.set_meta("budget_blocked", False)
            self.db.set_meta("policy_hash", policy_hash)
            if self.backend is None:
                self.backend = HTTPBackend(self.config, self.db) if self.config.backend == "http" else CommandBackend(self.config, self.db)
            if self.reviewer is None and self.config.reviewer_endpoint:
                self.reviewer = HTTPBackend(self.config, self.db, self.config.reviewer_endpoint)
            task_records = self.db.tasks()
            for row in task_records:
                from .contracts import TaskSpec
                self.config.validate_task(TaskSpec.from_dict(row["spec"]))
            specs = {row["id"]: row["spec"] for row in task_records}
            self.db._validate_graph(specs)
            self.db.validate_ownership_limits(specs, max_children=self.config.max_children,
                                              max_depth=self.config.max_delegation_depth)
            recovered = recover_integrations(self.root, self.db, self.config)
            if any(r["status"] == "blocked" for r in recovered):
                self.db.set_meta("paused", True)
            self.db.recover_expired(retry_safe=self.config.backend == "http")
            self.db.set_meta("hygiene", {"observed_at": time.time(), "findings": hygiene_scan(self.root, self.config)})
            self.last_emitted = self.db.conn.execute("SELECT COALESCE(MAX(seq),0) FROM events").fetchone()[0]
            last_heartbeat, last_report, last_probe, last_hygiene = 0.0, 0.0, time.monotonic(), time.monotonic()
            while not self.stop_event.is_set():
                if self.db.get_meta("stop_requested_owner") == self.owner:
                    self.stop_event.set()
                    break
                for task_id, (_, future) in list(self.active.items()):
                    if future.done():
                        if not future.cancelled():
                            exception = future.exception()
                            if exception:
                                # A control-plane failure must not silently drop a worker.
                                self.db.issue("supervisor_worker_failure", type(exception).__name__, task_id, "critical")
                                self.db.set_meta("paused", True)
                        del self.active[task_id]
                tick = time.monotonic()
                if tick - last_heartbeat >= self.config.heartbeat_seconds:
                    self._heartbeat()
                    last_heartbeat = tick
                if not self.resource_blocked and not self.db.get_meta("budget_blocked", False):
                    while len(self.active) < self.config.max_workers:
                        claim = self.db.claim(f"agent-{uuid.uuid4().hex[:10]}", lease_seconds=self.config.lease_seconds,
                                              max_active_per_cell=self.config.max_active_per_cell)
                        if claim is None:
                            break
                        future = asyncio.create_task(self.execute(claim), name=f"worker:{claim['id']}")
                        self.active[claim["id"]] = (claim, future)
                        self.peak_workers = max(self.peak_workers, len(self.active))
                if tick - last_probe >= self.config.endpoint.health_interval:
                    for backend in [self.backend, self.reviewer]:
                        if backend is not None and not any(t.get_name() == f"probe:{id(backend)}" for t in self.probes):
                            future = asyncio.create_task(backend.probe(), name=f"probe:{id(backend)}")
                            self.probes.add(future)
                    last_probe = tick
                for probe in list(self.probes):
                    if probe.done():
                        if not probe.cancelled() and probe.exception():
                            self.db.issue("probe_failure", type(probe.exception()).__name__, severity="warning")
                        self.probes.remove(probe)
                if tick - last_hygiene >= 60 and not self.active:
                    self.db.set_meta("hygiene", {"observed_at": time.time(), "findings": hygiene_scan(self.root, self.config)})
                    last_hygiene = tick
                self._emit()
                if tick - last_report >= self.config.heartbeat_seconds:
                    write_reports(self.control / "reports", snapshot(self.db))
                    last_report = tick
                if until_idle and not self.active:
                    break
                try:
                    await asyncio.wait_for(self.stop_event.wait(), timeout=self.config.poll_seconds)
                except asyncio.TimeoutError:
                    pass
            # Filled after cancellation/checkpoint cleanup, never from pre-shutdown state.
            return final_result
        finally:
            for _, future in self.active.values():
                future.cancel()
            await asyncio.gather(*(future for _, future in self.active.values()), return_exceptions=True)
            for probe in self.probes:
                probe.cancel()
            await asyncio.gather(*self.probes, return_exceptions=True)
            if self.backend is not None:
                await self.backend.close()
            if self.reviewer is not None:
                await self.reviewer.close()
            if acquired:
                self.db.release_runtime(self.owner)
                write_reports(self.control / "reports", snapshot(self.db))
            final_result.update(peak_workers=self.peak_workers,
                                task_states={task["id"]: task["status"] for task in self.db.tasks()})
            self.db.close()
            self._closed = True
