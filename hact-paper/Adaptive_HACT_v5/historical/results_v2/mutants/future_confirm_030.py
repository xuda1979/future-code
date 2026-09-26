"""SQLite WAL control plane with transactional claims and fencing tokens.

Every process uses its own Store. Do not share a connection across threads.
External operations are never performed while a SQLite transaction is held.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
import uuid
from typing import Any, Iterator

from .contracts import BudgetExceeded, ContractError, FencedError, TaskSpec, overlaps

SCHEMA_VERSION = 2
SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks(
 id TEXT PRIMARY KEY, spec TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
 priority INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 fence INTEGER NOT NULL DEFAULT 0, worker TEXT, lease_until REAL,
 available_at REAL NOT NULL DEFAULT 0, created_at REAL NOT NULL, updated_at REAL NOT NULL,
 error TEXT NOT NULL DEFAULT '', result TEXT, parent_id TEXT);
CREATE INDEX IF NOT EXISTS tasks_dispatch ON tasks(status,priority,available_at);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id,id);
CREATE TABLE IF NOT EXISTS attempts(
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), fence INTEGER NOT NULL,
 worker TEXT NOT NULL, status TEXT NOT NULL, started_at REAL NOT NULL, ended_at REAL,
 heartbeat_at REAL NOT NULL, progress_at REAL NOT NULL, step TEXT NOT NULL DEFAULT 'claimed');
CREATE TABLE IF NOT EXISTS events(
 seq INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, kind TEXT NOT NULL,
 task_id TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS issues(
 id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, task_id TEXT,
 severity TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL,
 detail TEXT NOT NULL, count INTEGER NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS evidence(
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
 kind TEXT NOT NULL, verdict TEXT NOT NULL, fingerprint TEXT NOT NULL,
 path TEXT NOT NULL, details TEXT NOT NULL, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS messages(
 seq INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, recipient TEXT NOT NULL REFERENCES tasks(id),
 content TEXT NOT NULL, created_at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS messages_inbox ON messages(recipient,seq);
CREATE TABLE IF NOT EXISTS task_memory(
 task_id TEXT PRIMARY KEY REFERENCES tasks(id), note TEXT NOT NULL DEFAULT '',
 revision INTEGER NOT NULL DEFAULT 0, delivered_seq INTEGER NOT NULL DEFAULT 0,
 updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS context_usage(
 seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
 attempt_id TEXT NOT NULL, kind TEXT NOT NULL, step INTEGER NOT NULL,
 chars INTEGER NOT NULL, utf8_bytes INTEGER NOT NULL, byte_limit INTEGER NOT NULL,
 fingerprint TEXT NOT NULL, details TEXT NOT NULL, created_at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS context_by_task ON context_usage(task_id,seq);
CREATE TABLE IF NOT EXISTS connections(
 name TEXT PRIMARY KEY, state TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0,
 observed_at REAL, last_success REAL, retry_at REAL, detail TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS reservations(
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL, tokens INTEGER NOT NULL,
 actual_tokens INTEGER, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS integrations(
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL, fence INTEGER NOT NULL,
 status TEXT NOT NULL, manifest TEXT NOT NULL, result TEXT NOT NULL, created_at REAL NOT NULL);
"""


def encode(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


class Store:
    def __init__(self, path: Path, *, readonly: bool = False):
        self.path = Path(path)
        self.readonly = readonly
        if readonly:
            self.conn = sqlite3.connect(f"file:{self.path.resolve().as_posix()}?mode=ro", uri=True, timeout=5)
        else:
            if self.path.is_symlink():
                raise ContractError("State database must not be a symlink")
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.conn = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.execute("PRAGMA busy_timeout=10000")
        if not readonly:
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.execute("PRAGMA synchronous=FULL")
            # Refuse incompatible state before applying DDL.
            exists = self.conn.execute("SELECT 1 FROM sqlite_master WHERE name='meta'").fetchone()
            if exists:
                version = self.get_meta("schema_version", SCHEMA_VERSION)
                if version not in {1, SCHEMA_VERSION}:
                    self.close()
                    raise ContractError(f"Unsupported state schema {version}")
            self.conn.executescript(SCHEMA)
            self.set_meta("schema_version", SCHEMA_VERSION)
            try:
                os.chmod(self.path, 0o600)
            except OSError:
                pass

    def __enter__(self) -> Store:
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    def close(self) -> None:
        self.conn.close()

    @contextmanager
    def transaction(self) -> Iterator[None]:
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.conn.execute("COMMIT")
        except BaseException:
            self.conn.execute("ROLLBACK")
            raise

    def rows(self, sql: str, parameters: tuple = ()) -> list[dict]:
        return [dict(r) for r in self.conn.execute(sql, parameters).fetchall()]

    def get_meta(self, key: str, default: Any = None) -> Any:
        row = self.conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set_meta(self, key: str, value: Any) -> None:
        self.conn.execute("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, encode(value)))

    def event(self, kind: str, task_id: str | None = None, **data: Any) -> int:
        cur = self.conn.execute("INSERT INTO events(ts,kind,task_id,data) VALUES(?,?,?,?)", (time.time(), kind, task_id, encode(data)))
        return int(cur.lastrowid)

    def _issue(self, category: str, detail: str, task_id: str | None, severity: str) -> str:
        fingerprint = hashlib.sha256(encode([category, task_id, detail]).encode()).hexdigest()
        issue_id = "I-" + fingerprint[:16]
        now = time.time()
        self.conn.execute("""INSERT INTO issues VALUES(?,?,?,?,?,'open',?,1,?,?)
            ON CONFLICT(fingerprint) DO UPDATE SET count=count+1,status='open',updated_at=excluded.updated_at""",
                          (issue_id, fingerprint, task_id, severity, category, detail[:4000], now, now))
        return issue_id

    def issue(self, category: str, detail: str, task_id: str | None = None, severity: str = "error") -> str:
        return self._issue(category, detail, task_id, severity)

    def resolve_issue(self, issue_id: str, reason: str) -> None:
        if not reason.strip():
            raise ContractError("Resolution requires a reason")
        with self.transaction():
            cur = self.conn.execute("UPDATE issues SET status='resolved',updated_at=? WHERE id=?", (time.time(), issue_id))
            if cur.rowcount != 1:
                raise ContractError("Unknown incident")
            self.event("issue.resolved", issue_id=issue_id, reason=reason[:1000])

    def tasks(self) -> list[dict]:
        result = self.rows("SELECT * FROM tasks ORDER BY priority,created_at,id")
        for r in result:
            r["spec"] = json.loads(r["spec"])
            r["result"] = json.loads(r["result"]) if r["result"] else None
        return result

    def task(self, task_id: str) -> dict:
        row = self.conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if row is None:
            raise ContractError(f"Unknown task {task_id}")
        r = dict(row)
        r["spec"] = json.loads(r["spec"])
        r["result"] = json.loads(r["result"]) if r["result"] else None
        return r

    @staticmethod
    def _validate_graph(specs: dict[str, dict]) -> None:
        for key, spec in specs.items():
            if any(d not in specs for d in spec["dependencies"]):
                raise ContractError(f"Task {key} has a missing dependency")
        for key, spec in specs.items():
            parent = spec.get("parent_id")
            if parent is not None and parent not in specs:
                raise ContractError(f"Task {key} has a missing parent")
        visited: set[str] = set()
        for key in specs:
            chain: set[str] = set()
            cursor: str | None = key
            while cursor is not None and cursor not in visited:
                if cursor in chain:
                    raise ContractError("Task ownership contains a cycle")
                chain.add(cursor)
                cursor = specs[cursor].get("parent_id")
            visited.update(chain)
        # Iterative Kahn traversal avoids recursion limits on large legitimate DAGs.
        indegree = {k: len(v["dependencies"]) for k, v in specs.items()}
        children: dict[str, list[str]] = {k: [] for k in specs}
        for k, v in specs.items():
            for dep in v["dependencies"]:
                children[dep].append(k)
        ready = [k for k, n in indegree.items() if n == 0]
        seen = 0
        while ready:
            key = ready.pop()
            seen += 1
            for child in children[key]:
                indegree[child] -= 1
                if indegree[child] == 0:
                    ready.append(child)
        if seen != len(specs):
            raise ContractError("Task dependencies contain a cycle")

    @staticmethod
    def validate_ownership_limits(specs: dict[str, dict], *, max_children: int,
                                  max_depth: int | None = None) -> None:
        if type(max_children) is not int or not 1 <= max_children <= 32:
            raise ContractError("Invalid direct-child ceiling")
        counts: dict[str, int] = {}
        for key, spec in specs.items():
            parent = spec.get("parent_id")
            expected = specs[parent]["depth"] + 1 if parent in specs else 0
            if spec["depth"] != expected:
                raise ContractError(f"Task {key} depth does not match ownership")
            if max_depth is not None and spec["depth"] > max_depth:
                raise ContractError("Task graph exceeds configured depth ceiling")
            if parent is not None:
                counts[parent] = counts.get(parent, 0) + 1
                if counts[parent] > max_children:
                    raise ContractError("Task graph exceeds lifetime direct-child ceiling")

    def _add(self, tasks: list[TaskSpec], max_total: int, *, max_children: int | None = None,
             max_depth: int | None = None) -> None:
        specs = {r["id"]: json.loads(r["spec"]) for r in self.conn.execute("SELECT id,spec FROM tasks")}
        new_ids = [t.id for t in tasks]
        if len(new_ids) != len(set(new_ids)) or set(new_ids) & specs.keys():
            raise ContractError("Task IDs must be unique and cannot replace existing tasks")
        if len(specs) + len(tasks) > max_total:
            raise ContractError("Task count ceiling reached")
        specs.update({t.id: t.to_dict() for t in tasks})
        self._validate_graph(specs)
        if max_children is not None:
            self.validate_ownership_limits(specs, max_children=max_children, max_depth=max_depth)
        now = time.time()
        for task in tasks:
            self.conn.execute("INSERT INTO tasks(id,spec,priority,created_at,updated_at,parent_id) VALUES(?,?,?,?,?,?)",
                              (task.id, encode(task.to_dict()), task.priority, now, now, task.parent_id))
            self.event("task.queued", task.id)

    def add_tasks(self, tasks: list[TaskSpec], *, max_total: int = 500,
                  max_children: int | None = None, max_depth: int | None = None) -> None:
        if not tasks:
            raise ContractError("At least one task is required")
        with self.transaction():
            self._add(tasks, max_total, max_children=max_children, max_depth=max_depth)

    def claim(self, worker: str, *, lease_seconds: float = 45,
              max_active_per_cell: int | None = None) -> dict | None:
        now = time.time()
        with self.transaction():
            if self.get_meta("paused", False):
                return None
            # Do not deserialize completed result blobs on every scheduling decision.
            statuses = dict(self.conn.execute("SELECT id,status FROM tasks"))
            running = self.rows("SELECT id,parent_id,spec FROM tasks WHERE status='running'")
            running_scopes = [json.loads(r["spec"])["write_scope"] for r in running]
            cell_load: dict[str, int] = {}
            for r in running:
                cell = r["parent_id"] or r["id"]
                cell_load[cell] = cell_load.get(cell, 0) + 1
            tasks = self.rows("SELECT * FROM tasks WHERE status IN ('queued','waiting','retry_wait') ORDER BY priority,created_at,id")
            if max_active_per_cell is not None:
                if type(max_active_per_cell) is not int or max_active_per_cell < 1:
                    raise ContractError("Cell concurrency ceiling must be positive")
                tasks.sort(key=lambda r: (r["priority"], cell_load.get(r["parent_id"] or r["id"], 0), r["created_at"], r["id"]))
            for row in tasks:
                row["spec"] = json.loads(row["spec"])
                if max_active_per_cell is not None and cell_load.get(row["parent_id"] or row["id"], 0) >= max_active_per_cell:
                    continue
                if row["status"] not in {"queued", "waiting", "retry_wait"} or row["available_at"] > now:
                    continue
                deps = row["spec"]["dependencies"]
                if any(statuses[d] in {"failed", "cancelled"} for d in deps):
                    self.conn.execute("UPDATE tasks SET status='blocked',error='Dependency failed or was cancelled',updated_at=? WHERE id=?", (now, row["id"]))
                    self._issue("dependency", "Dependency failed or was cancelled", row["id"], "error")
                    continue
                if not all(statuses[d] == "done" for d in deps):
                    continue
                if row["attempts"] >= row["spec"]["max_attempts"]:
                    self.conn.execute("UPDATE tasks SET status='blocked',error='Attempt ceiling reached',updated_at=? WHERE id=?", (now, row["id"]))
                    self._issue("attempt_budget", "Attempt ceiling reached", row["id"], "error")
                    continue
                if any(overlaps(row["spec"]["write_scope"], scopes) for scopes in running_scopes):
                    continue
                fence = row["fence"] + 1
                attempt_id = f"{row['id']}.{fence}"
                self.conn.execute("""UPDATE tasks SET status='running',attempts=attempts+1,fence=?,worker=?,lease_until=?,updated_at=? WHERE id=?""",
                                  (fence, worker, now + lease_seconds, now, row["id"]))
                self.conn.execute("INSERT INTO attempts(id,task_id,fence,worker,status,started_at,heartbeat_at,progress_at) VALUES(?,?,?,?,'running',?,?,?)",
                                  (attempt_id, row["id"], fence, worker, now, now, now))
                self.event("task.started", row["id"], fence=fence, worker=worker)
                result = self.task(row["id"])
                result["attempt_id"] = attempt_id
                return result
        return None

    def assert_owner(self, task_id: str, fence: int) -> None:
        row = self.conn.execute("SELECT status,fence,lease_until FROM tasks WHERE id=?", (task_id,)).fetchone()
        if not row or row["status"] != "running" or row["fence"] != fence or (row["lease_until"] or 0) <= time.time():
            raise FencedError("Task lease expired, was cancelled, or belongs to a newer attempt")

    def heartbeat(self, task_id: str, fence: int, *, lease_seconds: float = 45, step: str | None = None) -> None:
        with self.transaction():
            self.assert_owner(task_id, fence)
            now = time.time()
            self.conn.execute("UPDATE tasks SET lease_until=? WHERE id=?", (now + lease_seconds, task_id))
            self.conn.execute("UPDATE attempts SET heartbeat_at=? WHERE id=?", (now, f"{task_id}.{fence}"))
            if step is not None:
                self.conn.execute("UPDATE attempts SET progress_at=?,step=? WHERE id=?", (now, step[:160], f"{task_id}.{fence}"))

    def _finish(self, task_id: str, fence: int, status: str, result: dict | None, error: str, available_at: float) -> None:
        now = time.time()
        self.conn.execute("UPDATE tasks SET status=?,result=?,error=?,worker=NULL,lease_until=NULL,available_at=?,updated_at=? WHERE id=?",
                          (status, encode(result) if result is not None else None, error[:4000], available_at, now, task_id))
        self.conn.execute("UPDATE attempts SET status=?,ended_at=? WHERE id=?", (status, now, f"{task_id}.{fence}"))
        self.event(f"task.{status}", task_id, fence=fence, error=error[:1000])

    def finish(self, task_id: str, fence: int, status: str, *, result: dict | None = None, error: str = "", delay: float = 0) -> None:
        if status not in {"done", "blocked", "failed", "cancelled", "retry_wait", "waiting"}:
            raise ContractError("Invalid completion state")
        with self.transaction():
            self.assert_owner(task_id, fence)
            self._finish(task_id, fence, status, result, error, time.time() + delay)

    def defer_transport(self, task_id: str, fence: int, detail: str, delay: float) -> None:
        """Unavailable infrastructure does not consume the *code* retry allowance."""
        with self.transaction():
            self.assert_owner(task_id, fence)
            self._finish(task_id, fence, "retry_wait", None, detail, time.time() + delay)
            self.conn.execute("UPDATE tasks SET attempts=MAX(0,attempts-1) WHERE id=?", (task_id,))

    def recover_expired(self, *, retry_safe: bool = True) -> int:
        recovered = 0
        with self.transaction():
            for row in self.rows("SELECT * FROM tasks WHERE status='running' AND lease_until<=?", (time.time(),)):
                pending = self.conn.execute("SELECT 1 FROM integrations WHERE task_id=? AND status='prepared'", (row["id"],)).fetchone()
                if pending:
                    continue  # Commit journal reconciliation owns this task.
                spec = json.loads(row["spec"])
                status = "retry_wait" if retry_safe and row["attempts"] < spec["max_attempts"] else "blocked"
                self._finish(row["id"], row["fence"], status, None, "Worker lease expired; staged output was not trusted", time.time())
                self._issue("worker_lost", "Worker lease expired; inspect retained workspace", row["id"], "warning")
                recovered += 1
        return recovered

    def retry_task(self, task_id: str, *, reason: str) -> None:
        if not reason.strip():
            raise ContractError("Retry requires a new diagnostic or changed condition")
        with self.transaction():
            row = self.task(task_id)
            if row["status"] not in {"blocked", "failed", "retry_wait"}:
                raise ContractError("Only blocked, failed or waiting-for-retry tasks can be resumed")
            self.conn.execute("UPDATE tasks SET status='queued',attempts=0,error='',available_at=0,updated_at=? WHERE id=?", (time.time(), task_id))
            self.event("task.operator_retry", task_id, reason=reason[:1000])

    def cancel(self, task_id: str) -> None:
        with self.transaction():
            row = self.task(task_id)
            if row["status"] in {"done", "cancelled"}:
                return
            if self.conn.execute("SELECT 1 FROM integrations WHERE task_id=? AND status='prepared'", (task_id,)).fetchone():
                raise ContractError("Reconcile prepared integration before cancellation")
            self._finish(task_id, row["fence"], "cancelled", None, "Cancelled by operator", 0)
            # Descendants of a delegated parent are cancelled too.
            todo = [task_id]
            while todo:
                parent = todo.pop()
                for child in self.rows("SELECT id,fence,status FROM tasks WHERE parent_id=?", (parent,)):
                    if child["status"] not in {"done", "cancelled"}:
                        if self.conn.execute("SELECT 1 FROM integrations WHERE task_id=? AND status='prepared'", (child["id"],)).fetchone():
                            raise ContractError("A descendant has a prepared integration")
                        self._finish(child["id"], child["fence"], "cancelled", None, "Parent cancelled", 0)
                    todo.append(child["id"])

    def delegate(self, task_id: str, fence: int, children: list[TaskSpec], *, max_total: int, max_children: int = 8) -> None:
        if not children:
            raise ContractError("Delegation requires child tasks")
        with self.transaction():
            self.assert_owner(task_id, fence)
            parent = TaskSpec.from_dict(self.task(task_id)["spec"])
            count = self.conn.execute("SELECT COUNT(*) FROM tasks WHERE parent_id=?", (task_id,)).fetchone()[0]
            if (count + len(children) >= max_children):
                raise ContractError("Lifetime direct-child ceiling reached; subdivide through child coordinators")
            if any(c.parent_id != task_id or c.depth != parent.depth + 1 for c in children):
                raise ContractError("Child ownership/depth must match its delegating parent")
            self._add(children, max_total, max_children=max_children)
            parent.dependencies = list(dict.fromkeys(parent.dependencies + [c.id for c in children]))
            # Revalidate after mutation; do not silently bypass the task contract.
            parent = TaskSpec.from_dict(parent.to_dict())
            specs = {r["id"]: r["spec"] for r in self.tasks()}
            specs[task_id] = parent.to_dict()
            self._validate_graph(specs)
            self.conn.execute("UPDATE tasks SET spec=? WHERE id=?", (encode(parent.to_dict()), task_id))
            self._finish(task_id, fence, "waiting", {"delegated": [c.id for c in children]}, "", 0)
            # A successful yield is not a failure retry. Lifetime fan-out/depth/task
            # and request budgets still bound all future expansion.
            self.conn.execute("UPDATE tasks SET attempts=MAX(0,attempts-1) WHERE id=?", (task_id,))
            self.event("task.delegated", task_id, children=[c.id for c in children])

    def send_message(self, sender: str, fence: int, recipient: str, content: str) -> None:
        if not isinstance(content, str) or not content.strip() or len(content) > 3000:
            raise ContractError("Message must contain 1..3000 characters")
        with self.transaction():
            self.assert_owner(sender, fence)
            self.task(recipient)
            count = self.conn.execute("SELECT COUNT(*) FROM messages WHERE sender=?", (sender,)).fetchone()[0]
            if count >= 100:
                raise ContractError("Per-task message ceiling reached")
            self.conn.execute("INSERT INTO messages(sender,recipient,content,created_at) VALUES(?,?,?,?)", (sender, recipient, content, time.time()))
            self.event("message.sent", sender, recipient=recipient)

    def messages(self, recipient: str, after: int = 0, *, limit: int = 20) -> list[dict]:
        if type(after) is not int or after < 0 or type(limit) is not int or not 1 <= limit <= 32:
            raise ContractError("Invalid mailbox page")
        return self.rows("SELECT * FROM messages WHERE recipient=? AND seq>? ORDER BY seq LIMIT ?", (recipient, after, limit))

    def memory(self, task_id: str) -> dict:
        row = self.conn.execute("SELECT * FROM task_memory WHERE task_id=?", (task_id,)).fetchone()
        return dict(row) if row else {"task_id": task_id, "note": "", "revision": 0, "delivered_seq": 0, "updated_at": None}

    def write_note(self, task_id: str, fence: int, note: str, *, max_bytes: int = 1600,
                   expected_revision: int | None = None) -> dict:
        if not isinstance(note, str) or len(note.encode('utf-8')) > max_bytes:
            raise ContractError("Working note exceeds its byte ceiling")
        with self.transaction():
            self.assert_owner(task_id, fence)
            old = self.memory(task_id)
            if expected_revision is not None and (type(expected_revision) is not int or expected_revision != old["revision"]):
                raise ContractError("Working note revision conflict")
            self.conn.execute("""INSERT INTO task_memory VALUES(?,?,1,0,?)
                ON CONFLICT(task_id) DO UPDATE SET note=excluded.note,revision=revision+1,updated_at=excluded.updated_at""",
                              (task_id, note, time.time()))
            self.event("memory.replaced", task_id, revision=old["revision"] + 1)
            return self.memory(task_id)

    def mark_delivered(self, task_id: str, fence: int, sequence: int) -> None:
        # Delivery means present in a successful model request, NOT understood or acted upon.
        if type(sequence) is not int or sequence < 0:
            raise ContractError("Invalid delivery sequence")
        with self.transaction():
            self.assert_owner(task_id, fence)
            if sequence and not self.conn.execute("SELECT 1 FROM messages WHERE seq=? AND recipient=?", (sequence, task_id)).fetchone():
                raise ContractError("Delivery sequence does not belong to this mailbox")
            self.conn.execute("""INSERT INTO task_memory VALUES(?,'',0,?,?)
                ON CONFLICT(task_id) DO UPDATE SET delivered_seq=MAX(delivered_seq,excluded.delivered_seq),updated_at=excluded.updated_at""",
                              (task_id, sequence, time.time()))

    def record_context(self, task_id: str, fence: int, kind: str, step: int, messages: list[dict],
                       config: Any, details: dict) -> None:
        from .context import enforce_bounds, request_size
        enforce_bounds(messages, config)
        size = request_size(messages)
        with self.transaction():
            self.assert_owner(task_id, fence)
            self.conn.execute("""INSERT INTO context_usage(task_id,attempt_id,kind,step,chars,utf8_bytes,
                byte_limit,fingerprint,details,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)""",
                (task_id, f"{task_id}.{fence}", kind, step, size["chars"], size["utf8_bytes"],
                 config.max_context_bytes, hashlib.sha256(encode(messages).encode()).hexdigest(), encode(details), time.time()))

    def add_evidence(self, task_id: str, attempt_id: str, kind: str, verdict: str, fingerprint: str, path: str, details: dict) -> str:
        if verdict not in {"PASS", "FAIL", "UNKNOWN", "VOID"}:
            raise ContractError("Invalid evidence verdict")
        evidence_id = "E-" + uuid.uuid4().hex[:20]
        self.conn.execute("INSERT INTO evidence VALUES(?,?,?,?,?,?,?,?,?)",
                          (evidence_id, task_id, attempt_id, kind, verdict, fingerprint, path, encode(details), time.time()))
        self.event("gate.passed" if verdict == "PASS" else "gate.not_passed", task_id, evidence_id=evidence_id, gate=kind, verdict=verdict)
        return evidence_id

    def reserve(self, task_id: str, tokens: int, *, max_requests: int, max_tokens: int) -> str:
        if type(tokens) is not int or tokens < 0:
            raise ContractError("Invalid token reservation")
        with self.transaction():
            totals = self.conn.execute("SELECT COUNT(*),COALESCE(SUM(tokens),0) FROM reservations").fetchone()
            if totals[0] >= max_requests or totals[1] + tokens > max_tokens:
                raise BudgetExceeded("Request/token reservation budget reached; explicit budget increase required")
            reservation = "R-" + uuid.uuid4().hex
            self.conn.execute("INSERT INTO reservations VALUES(?,?,?,NULL,?)", (reservation, task_id, tokens, time.time()))
            return reservation

    def record_usage(self, reservation: str, actual_tokens: int | None) -> None:
        if actual_tokens is not None and (type(actual_tokens) is not int or actual_tokens < 0):
            raise ContractError("Invalid provider usage")
        self.conn.execute("UPDATE reservations SET actual_tokens=? WHERE id=?", (actual_tokens, reservation))

    def connection(self, name: str, state: str, *, failures: int = 0, retry_at: float | None = None, detail: str = "", success: bool = False) -> None:
        now = time.time()
        self.conn.execute("""INSERT INTO connections VALUES(?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET
          state=excluded.state,failures=excluded.failures,observed_at=excluded.observed_at,
          last_success=CASE WHEN excluded.last_success IS NOT NULL THEN excluded.last_success ELSE connections.last_success END,
          retry_at=excluded.retry_at,detail=excluded.detail""",
                          (name, state, failures, now, now if success else None, retry_at, detail[:1000]))

    def acquire_runtime(self, owner: str, *, lease_seconds: float) -> None:
        with self.transaction():
            lease = self.get_meta("runtime_lease", {})
            if lease.get("until", 0) > time.time() and lease.get("owner") != owner:
                raise ContractError("Another daemon holds the runtime lease")
            self.set_meta("runtime_lease", {"owner": owner, "until": time.time() + lease_seconds, "pid": os.getpid()})
            self.set_meta("runtime", {"state": "STARTING", "heartbeat_at": time.time(), "owner": owner})

    def runtime_heartbeat(self, owner: str, state: str, *, lease_seconds: float) -> None:
        with self.transaction():
            lease = self.get_meta("runtime_lease", {})
            if lease.get("owner") != owner or lease.get("until", 0) <= time.time():
                raise FencedError("Runtime lease was lost")
            lease["until"] = time.time() + lease_seconds
            self.set_meta("runtime_lease", lease)
            self.set_meta("runtime", {"state": state, "heartbeat_at": time.time(), "owner": owner})

    def release_runtime(self, owner: str) -> None:
        with self.transaction():
            lease = self.get_meta("runtime_lease", {})
            if lease.get("owner") == owner:
                self.set_meta("runtime_lease", {})
                self.set_meta("runtime", {"state": "STOPPED", "heartbeat_at": time.time(), "owner": owner})

    def prepare_integration(self, task_id: str, fence: int, manifest: dict, result: dict) -> str:
        journal_id = f"{task_id}.{fence}"
        with self.transaction():
            self.assert_owner(task_id, fence)
            self.conn.execute("INSERT INTO integrations VALUES(?,?,?,'prepared',?,?,?)",
                              (journal_id, task_id, fence, encode(manifest), encode(result), time.time()))
            self.event("integration.prepared", task_id, journal_id=journal_id)
        return journal_id

    def complete_integration(self, journal_id: str, *, recovery: bool = False) -> None:
        with self.transaction():
            row = self.conn.execute("SELECT * FROM integrations WHERE id=?", (journal_id,)).fetchone()
            if not row or row["status"] != "prepared":
                raise ContractError("Integration journal is not prepared")
            if not recovery:
                self.assert_owner(row["task_id"], row["fence"])
            self.conn.execute("UPDATE integrations SET status='committed' WHERE id=?", (journal_id,))
            self._finish(row["task_id"], row["fence"], "done", json.loads(row["result"]), "", 0)
            self.event("integration.recovered" if recovery else "integration.committed", row["task_id"], journal_id=journal_id)

    def block_integration(self, journal_id: str, detail: str) -> None:
        with self.transaction():
            row = self.conn.execute("SELECT * FROM integrations WHERE id=?", (journal_id,)).fetchone()
            if not row:
                raise ContractError("Unknown integration")
            self.conn.execute("UPDATE integrations SET status='conflict' WHERE id=?", (journal_id,))
            self._finish(row["task_id"], row["fence"], "blocked", None, detail, 0)
            self._issue("integration_conflict", detail, row["task_id"], "critical")
