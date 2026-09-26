"""Versioned, deterministic status projections. No LLM formats operational tables."""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
import html
import json
from pathlib import Path
import time
from typing import Any

from .coordination import rollups
from .security import Redactor, atomic_write
from .store import Store

# Insertion order and columns are part of the public reporting contract.
TABLES: dict[str, tuple[tuple[str, str], ...]] = {
    "system": (("component", "Component"), ("state", "State"), ("evidence", "Evidence"), ("observed_at", "Observed (UTC)"), ("freshness", "Freshness")),
    "tasks": (("id", "Task"), ("title", "Objective"), ("role", "Role"), ("state", "State"), ("priority", "Priority"), ("attempts", "Attempts"), ("quality", "Quality"), ("blocker", "Blocker")),
    "agents": (("worker", "Agent"), ("task", "Task"), ("fence", "Fence"), ("state", "State"), ("step", "Current operation"), ("heartbeat_age", "Heartbeat age (s)"), ("progress_age", "Progress age (s)")),
    "connections": (("name", "Connection"), ("state", "Observed state"), ("failures", "Failures"), ("retry_at", "Next eligible retry (UTC)"), ("last_success", "Last inference success (UTC)"), ("freshness", "Freshness"), ("detail", "Evidence / limitation")),
    "dependencies": (("task", "Task"), ("depends_on", "Depends on"), ("state", "Dependency state"), ("satisfied", "Satisfied")),
    "quality": (("task", "Task"), ("gate", "Gate"), ("verdict", "Latest verdict"), ("attempt", "Attempt"), ("fingerprint", "Input fingerprint"), ("evidence", "Evidence ID")),
    "incidents": (("id", "Incident"), ("severity", "Severity"), ("state", "State"), ("task", "Task"), ("category", "Category"), ("count", "Occurrences"), ("detail", "Finding")),
    "artifacts": (("task", "Task"), ("path", "Artifact"), ("sha256", "SHA-256 at integration"), ("verification", "Verification scope")),
    "budget": (("resource", "Resource"), ("used", "Used / reserved"), ("limit", "Ceiling"), ("measurement", "Measurement")),
    "hygiene": (("path", "Path"), ("finding", "Finding"), ("action", "Action")),
    "hierarchy": (("task", "Coordinator task"), ("parent", "Parent"), ("state", "Task state"),
                  ("children", "Direct children"), ("leaves", "Subtree leaves"), ("completed", "Completed leaves"),
                  ("leaf_gates_pass", "Leaves with gate PASS"), ("unknown", "Completed leaves without PASS"),
                  ("blocked", "Blocked/failed/cancelled in subtree"), ("active", "Active in subtree"),
                  ("own_quality", "Own integration checks")),
    "contexts": (("task", "Task"), ("role", "Role"), ("calls", "Recorded request admissions"),
                 ("peak_bytes", "Peak input UTF-8 bytes"), ("limit_bytes", "Minimum recorded byte ceiling"),
                 ("bounds", "Input bounds"), ("measurement", "Measurement scope")),
    "mailboxes": (("task", "Recipient"), ("total", "Stored messages"), ("pending", "Not yet delivered"),
                  ("cursor", "Delivered through sequence"), ("note_revision", "Working note revision"),
                  ("note_bytes", "Working note UTF-8 bytes"), ("semantics", "Delivery scope")),
}


def iso(value: float | None) -> str:
    if value is None:
        return "UNKNOWN"
    return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def freshness(timestamp: float | None, now: float, stale_seconds: float) -> str:
    if timestamp is None:
        return "UNKNOWN"
    return "FRESH" if 0 <= now - timestamp <= stale_seconds else "STALE"


def snapshot(db: Store, *, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    # One consistent database snapshot, including on a separate read-only HTTP connection.
    db.conn.execute("BEGIN")
    try:
        runtime = db.get_meta("runtime", {})
        stale_seconds = db.get_meta("stale_seconds", 30)
        fresh = freshness(runtime.get("heartbeat_at"), now, stale_seconds)
        state = runtime.get("state", "UNKNOWN")
        if fresh != "FRESH" and state != "STOPPED":
            state = "UNKNOWN"
        tables: dict[str, list[dict]] = {name: [] for name in TABLES}
        tables["system"].append({"component": "supervisor", "state": state,
                                 "evidence": "Persisted heartbeat; not a claim that every task is healthy",
                                 "observed_at": iso(runtime.get("heartbeat_at")), "freshness": fresh})
        tables["system"].append({"component": "operator_pause", "state": "PAUSED" if db.get_meta("paused", False) else "NOT_PAUSED",
                                 "evidence": "Persisted operator control", "observed_at": iso(now), "freshness": "CURRENT_SNAPSHOT"})
        policy = db.get_meta("execution_policy", {})
        capacity = db.get_meta("capacity", {})
        for component, value, evidence in (
            ("worker_capacity", policy.get("max_workers", "UNKNOWN"), "Configured concurrency ceiling, not measured throughput"),
            ("backend", policy.get("backend", "UNKNOWN"), "Selected adapter; external inference is tracked separately"),
            ("context_char_limit", policy.get("context_chars", "UNKNOWN"), "Configured serialized context ceiling, not a token measurement"),
            ("context_byte_limit", policy.get("context_bytes", "UNKNOWN"), "Measured UTF-8 input ceiling; provider-added framing is outside this measurement"),
            ("coordination", policy.get("topology", "UNKNOWN"), "No central LLM manager; deterministic single-host scheduler is still shared infrastructure"),
            ("direct_child_limit", policy.get("max_children", "UNKNOWN"), "Lifetime child count per coordinator, not one delegation batch"),
            ("active_per_cell_limit", policy.get("max_active_per_cell", "UNKNOWN"), "Concurrent direct children sharing a parent"),
        ):
            tables["system"].append({"component": component, "state": value, "evidence": evidence,
                                     "observed_at": iso(policy.get("observed_at")),
                                     "freshness": "CONFIGURED_AT_START" if policy else "UNKNOWN"})
        tables["system"].append({"component": "storage_free_bytes", "state": capacity.get("free_bytes", "UNKNOWN"),
                                 "evidence": "Free space on project filesystem at last sample",
                                 "observed_at": iso(capacity.get("observed_at")),
                                 "freshness": freshness(capacity.get("observed_at"), now, stale_seconds)})
        tasks = db.tasks()
        by_id = {t["id"]: t for t in tasks}
        for task in sorted(tasks, key=lambda t: (t["priority"], t["id"])):
            result = task["result"] or {}
            tables["tasks"].append({"id": task["id"], "title": task["spec"]["title"], "role": task["spec"]["role"],
                                    "state": task["status"].upper(), "priority": task["priority"], "attempts": task["attempts"],
                                    "quality": result.get("quality", "UNKNOWN"), "blocker": task["error"] or "NONE_RECORDED"})
            for dep in sorted(task["spec"]["dependencies"]):
                dep_state = by_id.get(dep, {}).get("status", "UNKNOWN")
                tables["dependencies"].append({"task": task["id"], "depends_on": dep, "state": dep_state.upper(),
                                               "satisfied": "YES" if dep_state == "done" else "NO"})
            for artifact in sorted(result.get("artifacts", []), key=lambda a: a["path"]):
                tables["artifacts"].append({"task": task["id"], **artifact, "verification": "RECORDED_AT_COMMIT; later edits not revalidated"})
        for attempt in db.rows("SELECT * FROM attempts WHERE status='running' ORDER BY worker,task_id"):
            task = by_id[attempt["task_id"]]
            heartbeat_age = max(0, now - attempt["heartbeat_at"])
            live = (task["lease_until"] or 0) > now and fresh == "FRESH"
            tables["agents"].append({"worker": attempt["worker"], "task": attempt["task_id"], "fence": attempt["fence"],
                                     "state": "ACTIVE" if live else "UNKNOWN", "step": attempt["step"],
                                     "heartbeat_age": round(heartbeat_age, 2), "progress_age": round(max(0, now - attempt["progress_at"]), 2)})
        for connection in db.rows("SELECT * FROM connections ORDER BY name"):
            f = freshness(connection["observed_at"], now, stale_seconds)
            tables["connections"].append({"name": connection["name"], "state": connection["state"], "failures": connection["failures"],
                                          "retry_at": iso(connection["retry_at"]) if connection["retry_at"] else "NONE_SCHEDULED",
                                          "last_success": iso(connection["last_success"]), "freshness": f, "detail": connection["detail"]})
        latest = db.rows("""SELECT e.* FROM evidence e WHERE e.rowid=(
            SELECT MAX(e2.rowid) FROM evidence e2 WHERE e2.task_id=e.task_id AND e2.kind=e.kind)
            ORDER BY e.task_id,e.kind""")
        for item in latest:
            tables["quality"].append({"task": item["task_id"], "gate": item["kind"], "verdict": item["verdict"], "attempt": item["attempt_id"],
                                      "fingerprint": item["fingerprint"], "evidence": item["id"]})
        for issue in db.rows("SELECT * FROM issues ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'error' THEN 1 ELSE 2 END,id"):
            tables["incidents"].append({"id": issue["id"], "severity": issue["severity"].upper(), "state": issue["status"].upper(),
                                       "task": issue["task_id"] or "SYSTEM", "category": issue["category"], "count": issue["count"], "detail": issue["detail"]})
        totals = db.conn.execute("SELECT COUNT(*),COALESCE(SUM(tokens),0),SUM(actual_tokens),SUM(CASE WHEN actual_tokens IS NULL THEN 1 ELSE 0 END) FROM reservations").fetchone()
        budget = db.get_meta("budget_limits", {})
        tables["budget"] = [
            {"resource": "completion_requests", "used": totals[0], "limit": budget.get("requests", "UNKNOWN"), "measurement": "Durable pre-call reservations; includes uncertain/failed requests"},
            {"resource": "token_reservations", "used": totals[1], "limit": budget.get("tokens", "UNKNOWN"), "measurement": "Conservative byte-based estimate, not measured usage"},
            {"resource": "provider_reported_tokens", "used": totals[2] if totals[2] is not None else "UNKNOWN", "limit": "NOT_SEPARATE", "measurement": f"Partial when usage is missing; {totals[3] or 0} calls lack usage"},
            {"resource": "monetary_cost", "used": "UNKNOWN", "limit": "NOT_CONFIGURED", "measurement": "No tariff or billing integration; never inferred from tokens"},
        ]
        hygiene = db.get_meta("hygiene", {})
        if "findings" not in hygiene:
            tables["hygiene"] = [{"path": "PROJECT", "finding": "UNKNOWN: scan has not run", "action": "NO_DELETION"}]
        elif not hygiene["findings"]:
            tables["hygiene"] = [{"path": "PROJECT", "finding": f"No configured-pattern findings at {iso(hygiene.get('observed_at'))}; not a complete code audit", "action": "NO_DELETION"}]
        else:
            tables["hygiene"] = [{"path": f["path"], "finding": f["reason"], "action": "REVIEW_REQUIRED; NO_SOURCE_DELETION"}
                                  for f in sorted(hygiene["findings"], key=lambda x: (x["path"], x["reason"]))]
        for key, count in sorted(rollups(tasks).items()):
            if not count["direct_children"]:
                continue
            task = by_id[key]
            tables["hierarchy"].append({"task": key, "parent": task["parent_id"] or "ROOT",
                "state": task["status"].upper(), "children": count["direct_children"],
                "leaves": count["leaves"], "completed": count["completed_leaves"],
                "leaf_gates_pass": count["leaf_checks_pass"], "unknown": count["unknown_leaves"],
                "blocked": count["blocked_subtree"], "active": count["active_subtree"],
                "own_quality": (task["result"] or {}).get("quality", "UNKNOWN")})
        existing_tables = {r[0] for r in db.conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "context_usage" in existing_tables:
            for item in db.rows("""SELECT task_id,COUNT(*) AS calls,MAX(utf8_bytes) AS peak,MIN(byte_limit) AS ceiling,
                        SUM(CASE WHEN utf8_bytes>byte_limit THEN 1 ELSE 0 END) AS violations
                        FROM context_usage GROUP BY task_id ORDER BY task_id"""):
                tables["contexts"].append({"task": item["task_id"], "role": by_id[item["task_id"]]["spec"]["role"],
                    "calls": item["calls"], "peak_bytes": item["peak"], "limit_bytes": item["ceiling"],
                    "bounds": "FAIL" if item["violations"] else "PASS",
                    "measurement": "Serialized input bytes at admission; not provider tokens, output size or model quality"})
        if "task_memory" in existing_tables:
            for task in tasks:
                memory = db.memory(task["id"])
                counts = db.conn.execute("SELECT COUNT(*),COALESCE(SUM(CASE WHEN seq>? THEN 1 ELSE 0 END),0) FROM messages WHERE recipient=?",
                                         (memory["delivered_seq"], task["id"])).fetchone()
                if counts[0] or memory["revision"]:
                    tables["mailboxes"].append({"task": task["id"], "total": counts[0], "pending": counts[1],
                        "cursor": memory["delivered_seq"], "note_revision": memory["revision"],
                        "note_bytes": len(memory["note"].encode()),
                        "semantics": "Delivered in a successful model request, not proof of comprehension or execution"})
        seq = db.conn.execute("SELECT COALESCE(MAX(seq),0) FROM events").fetchone()[0]
        counts = Counter(t["status"] for t in tasks)
        output = {"schema_version": 2, "generated_at": iso(now), "event_sequence": seq,
                  "system": tables["system"], "task_counts": dict(sorted(counts.items())), "tables": tables}
        db.conn.execute("COMMIT")
        return Redactor().value(output)
    except BaseException:
        db.conn.execute("ROLLBACK")
        raise


def markdown_cell(value: Any) -> str:
    text = str(value).replace("\\", "\\\\").replace("|", "\\|").replace("\r", " ").replace("\n", " ")
    return text if len(text) <= 200 else text[:197] + "..."


def render_markdown(data: dict) -> str:
    parts = ["# Future Code - System Status", "", f"Schema: {data['schema_version']} | Snapshot: {data['generated_at']} | Event: {data['event_sequence']}",
             "", "PASS refers only to the named check and recorded input. UNKNOWN and STALE are never converted to PASS.",
             "Cells longer than 200 characters are shortened here; status.json retains full structured values.", ""]
    for name, columns in TABLES.items():
        parts += [f"## {name.replace('_', ' ').title()}", "", "| " + " | ".join(label for _, label in columns) + " |",
                  "| " + " | ".join("---" for _ in columns) + " |"]
        rows = data["tables"].get(name, [])
        if not rows:
            parts.append("| " + " | ".join(["NO_RECORDS"] + ["N/A"] * (len(columns) - 1)) + " |")
        for row in rows:
            parts.append("| " + " | ".join(markdown_cell(row.get(key, "UNKNOWN")) for key, _ in columns) + " |")
        parts.append("")
    return "\n".join(parts)


def render_html(data: dict) -> str:
    sections = []
    for name, columns in TABLES.items():
        headers = "".join(f"<th>{html.escape(label)}</th>" for _, label in columns)
        rows = "".join("<tr>" + "".join(f"<td>{html.escape(str(row.get(key, 'UNKNOWN')))}</td>" for key, _ in columns) + "</tr>"
                       for row in data["tables"].get(name, []))
        if not rows:
            rows = f'<tr><td colspan="{len(columns)}">NO_RECORDS</td></tr>'
        sections.append(f'<section id="{name}"><h2>{name.title()}</h2><div class="scroll"><table><thead><tr>{headers}</tr></thead><tbody>{rows}</tbody></table></div></section>')
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>Future Code Status</title><style>body{font:14px system-ui;margin:24px;background:#101820;color:#e6edf3}h1,h2{font-weight:600}.meta{color:#aebdcc}section{margin:28px 0}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;background:#172430}th,td{text-align:left;border:1px solid #344756;padding:10px;vertical-align:top;max-width:600px;overflow-wrap:anywhere}th{background:#213749}a{color:#7ac7ff}</style></head><body><h1>Future Code - System Status</h1><p class="meta">' + html.escape(f"Snapshot {data['generated_at']} | Schema {data['schema_version']} | Event {data['event_sequence']}") + '</p><p>PASS = named checks only. Model claims are not operational evidence. STALE / UNKNOWN require investigation.</p><p><a href="/v1/status">JSON</a> | <a href="/metrics">Metrics</a></p>' + "".join(sections) + "</body></html>"


def render_metrics(data: dict) -> str:
    lines = ["# HELP future_code_tasks Number of persisted tasks by lifecycle state.", "# TYPE future_code_tasks gauge"]
    for state in ("queued", "running", "waiting", "retry_wait", "blocked", "done", "failed", "cancelled"):
        lines.append(f'future_code_tasks{{state="{state}"}} {data["task_counts"].get(state,0)}')
    lines += ["# HELP future_code_active_agents Workers with current leases and a fresh supervisor heartbeat.", "# TYPE future_code_active_agents gauge",
              f'future_code_active_agents {sum(r["state"] == "ACTIVE" for r in data["tables"]["agents"])}',
              "# HELP future_code_open_incidents Unresolved recorded incidents.", "# TYPE future_code_open_incidents gauge",
              f'future_code_open_incidents {sum(r["state"] == "OPEN" for r in data["tables"]["incidents"])}']
    contexts = data["tables"].get("contexts", [])
    lines += ["# HELP future_code_peak_context_bytes Largest admitted serialized UTF-8 input.",
              "# TYPE future_code_peak_context_bytes gauge",
              f'future_code_peak_context_bytes {max((r["peak_bytes"] for r in contexts), default=0)}',
              "# HELP future_code_pending_messages Messages not delivered to a successful model request.",
              "# TYPE future_code_pending_messages gauge",
              f'future_code_pending_messages {sum(r["pending"] for r in data["tables"].get("mailboxes", []))}']
    return "\n".join(lines) + "\n"


def write_reports(directory: Path, data: dict) -> None:
    # JSON is authoritative; markdown/HTML explicitly identify their snapshot event and time.
    atomic_write(directory / "status.json", json.dumps(data, ensure_ascii=False, sort_keys=False, indent=2).encode())
    atomic_write(directory / "STATUS.md", render_markdown(data).encode())
    atomic_write(directory / "status.html", render_html(data).encode())
