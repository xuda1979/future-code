"""Operational CLI. Daemon output is structured; status tables have a frozen schema."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import signal
import sqlite3
import sys
import time

from . import __version__
from .contracts import Config, ContractError, TaskSpec
from .coordination import build_hierarchy
from .dashboard import make_server
from .quality import validate_experiment
from .reporting import render_markdown, snapshot
from .runtime import Supervisor
from .security import Redactor, atomic_write, ensure_control
from .store import Store
from .transport import HTTPBackend
from .workspace import Workspace, hygiene_scan


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="future-control", description="Durable multi-agent control plane; original Future Code CLI is optional")
    p.add_argument("--version", action="version", version=__version__)
    p.add_argument("--project", type=Path, default=Path.cwd())
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("init", help="Create private runtime configuration; does not run an LLM")
    submit = sub.add_parser("submit", help="Atomically validate and queue a task DAG")
    submit.add_argument("file", type=Path)
    submit.add_argument("--hierarchy", action="store_true", help="Wrap flat leaf tasks in bounded recursive integrator groups")
    submit.add_argument("--root-id", default="project-root")
    submit.add_argument("--fanout", type=int, default=8)
    submit.add_argument("--integration-gate", action="append", default=[], help="Approved root integration gate (repeatable)")
    run = sub.add_parser("run", help="Keep supervising until explicitly stopped")
    run.add_argument("--until-idle", action="store_true", help="Explicit one-shot mode; stop when no tasks can currently run")
    run.add_argument("--quiet", action="store_true", help="Write reports without emitting event deltas")
    status = sub.add_parser("status")
    status.add_argument("--json", action="store_true")
    status.add_argument("--watch", action="store_true")
    status.add_argument("--interval", type=float, default=5)
    sub.add_parser("pause", help="Stop new dispatch; current tasks drain normally")
    resume = sub.add_parser("resume", help="Resume dispatch; does not automatically retry blocked tasks")
    resume.add_argument("--reason", required=True)
    sub.add_parser("stop", help="Request cooperative daemon shutdown")
    cancel = sub.add_parser("cancel")
    cancel.add_argument("task_id")
    retry = sub.add_parser("retry")
    retry.add_argument("task_id")
    retry.add_argument("--reason", required=True)
    inspect = sub.add_parser("inspect")
    inspect.add_argument("task_id")
    resolve = sub.add_parser("resolve")
    resolve.add_argument("issue_id")
    resolve.add_argument("--reason", required=True)
    events = sub.add_parser("events")
    events.add_argument("--after", type=int, default=0)
    events.add_argument("--limit", type=int, default=100)
    doctor = sub.add_parser("doctor")
    doctor.add_argument("--probe", action="store_true", help="Probe only the configured non-billable health URL")
    serve = sub.add_parser("serve", help="Read-only loopback dashboard; no external bind")
    serve.add_argument("--port", type=int, default=8765)
    serve.add_argument("--token-env", default="FUTURE_CODE_DASHBOARD_TOKEN")
    cleanup = sub.add_parser("cleanup", help="Review completed, runtime-owned workspaces only")
    cleanup.add_argument("--apply", action="store_true")
    cleanup.add_argument("--older-than-hours", type=float, default=24)
    verify = sub.add_parser("verify-experiment")
    verify.add_argument("file", type=Path)
    return p


def project_paths(root: Path) -> tuple[Path, Path]:
    control = root / ".future-code"
    return control / "config.json", control / "state.db"


async def run_daemon(root: Path, config: Config, args: argparse.Namespace) -> dict:
    callback = None if args.quiet else lambda event: print(json.dumps(event), file=sys.stderr, flush=True)
    supervisor = Supervisor(root, config, event_callback=callback)
    loop = asyncio.get_running_loop()
    registered = []
    for name in ("SIGINT", "SIGTERM"):
        sig = getattr(signal, name)
        try:
            loop.add_signal_handler(sig, supervisor.stop)
            registered.append(sig)
        except (NotImplementedError, RuntimeError):
            pass
    try:
        return await supervisor.run(until_idle=args.until_idle)
    finally:
        for sig in registered:
            loop.remove_signal_handler(sig)


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    root = args.project.resolve()
    try:
        config_path, database = project_paths(root)
        if args.command == "init":
            root.mkdir(parents=True, exist_ok=True)
            control = ensure_control(root)
            if config_path.exists():
                raise ContractError("Configuration already exists; it was not overwritten")
            atomic_write(config_path, json.dumps(Config().to_dict(), indent=2).encode())
            with Store(database) as db:
                db.event("project.initialized")
            print(json.dumps({"state": "INITIALIZED", "config": str(config_path), "note": "Configure model and trusted acceptance gates before submitting write tasks"}))
            return 0
        if not database.is_file():
            raise ContractError("Project is not initialized; run init first")
        if args.command == "status":
            if args.interval < 0.1:
                raise ContractError("Watch interval must be >=0.1 seconds")
            while True:
                with Store(database, readonly=True) as db:
                    data = snapshot(db)
                if args.watch and sys.stdout.isatty():
                    print("\033[2J\033[H", end="")
                print(json.dumps(data, indent=2) if args.json else render_markdown(data), flush=True)
                if not args.watch:
                    return 0
                time.sleep(args.interval)
        config = Config.load(config_path)
        if args.command == "run":
            result = asyncio.run(run_daemon(root, config, args))
            print(json.dumps({"state": "STOPPED", **result}))
            # A deliberate stop of continuous mode is successful even with retained work.
            # Otherwise Restart=on-failure could defeat an administrative stop.
            return 0 if not args.until_idle or all(v == "done" for v in result["task_states"].values()) else 3
        if args.command == "serve":
            if not 0 <= args.port <= 65535:
                raise ContractError("Port out of range")
            server = make_server(database, port=args.port, token=os.environ.get(args.token_env, ""))
            print(json.dumps({"state": "SERVING_READ_ONLY", "address": f"127.0.0.1:{server.server_port}"}), flush=True)
            try:
                server.serve_forever(poll_interval=0.2)
            finally:
                server.server_close()
            return 0
        with Store(database) as db:
            if args.command == "submit":
                obj = json.loads(args.file.read_text(encoding="utf-8"))
                if isinstance(obj, dict):
                    if set(obj) != {"tasks"}:
                        raise ContractError("Task envelope must have only the 'tasks' field")
                    obj = obj["tasks"]
                if not isinstance(obj, list):
                    raise ContractError("Task file must contain a list or a tasks envelope")
                tasks = [TaskSpec.from_dict(item) for item in obj]
                if args.hierarchy:
                    if args.fanout > config.max_children:
                        raise ContractError("Hierarchy fanout exceeds configured max_children")
                    tasks = build_hierarchy(tasks, root_id=args.root_id, fanout=args.fanout,
                                            max_depth=config.max_delegation_depth, root_gates=args.integration_gate)
                elif args.integration_gate:
                    raise ContractError("--integration-gate requires --hierarchy")
                for task in tasks:
                    config.validate_task(task)
                db.add_tasks(tasks, max_total=config.max_total_tasks,
                             max_children=config.max_children, max_depth=config.max_delegation_depth)
                print(json.dumps({"state": "QUEUED", "tasks": [t.id for t in tasks]}))
            elif args.command == "pause":
                db.set_meta("paused", True)
                db.event("operator.pause")
                print('{"state":"PAUSED_DISPATCH","active_tasks":"DRAINING"}')
            elif args.command == "resume":
                if not args.reason.strip():
                    raise ContractError("Resume requires a reason")
                db.set_meta("paused", False)
                db.event("operator.resume", reason=args.reason[:1000])
                print('{"state":"DISPATCH_RESUMED","blocked_tasks":"UNCHANGED"}')
            elif args.command == "stop":
                lease = db.get_meta("runtime_lease", {})
                db.set_meta("stop_requested_owner", lease.get("owner"))
                db.event("operator.stop_requested")
                print('{"state":"STOP_REQUESTED"}')
            elif args.command == "cancel":
                db.cancel(args.task_id)
                print(json.dumps({"state": "CANCELLED", "task": args.task_id}))
            elif args.command == "retry":
                db.retry_task(args.task_id, reason=args.reason)
                print(json.dumps({"state": "QUEUED", "task": args.task_id}))
            elif args.command == "inspect":
                print(json.dumps(Redactor().value(db.task(args.task_id)), indent=2))
            elif args.command == "resolve":
                db.resolve_issue(args.issue_id, args.reason)
                print(json.dumps({"state": "RESOLVED", "issue": args.issue_id}))
            elif args.command == "events":
                if not 1 <= args.limit <= 10000 or args.after < 0:
                    raise ContractError("Invalid event range")
                rows = db.rows("SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?", (args.after, args.limit))
                for row in rows:
                    row["data"] = json.loads(row["data"])
                    print(json.dumps(Redactor().value(row)))
            elif args.command == "doctor":
                if args.probe:
                    async def probe():
                        backend = HTTPBackend(config, db)
                        try:
                            await backend.probe()
                        finally:
                            await backend.close()
                    asyncio.run(probe())
                findings = hygiene_scan(root, config)
                db.set_meta("hygiene", {"observed_at": time.time(), "findings": findings})
                print(json.dumps({"python": sys.version.split()[0], "config": "PASS", "database": db.conn.execute("PRAGMA quick_check").fetchone()[0],
                                  "backend": config.backend, "credential_configured": bool(os.environ.get(config.endpoint.api_key_env)),
                                  "health_probe": "CONFIGURED_ROUTE_ONLY" if args.probe else "NOT_RUN", "hygiene_findings": findings,
                                  "original_cli_rebuild": "NOT_AVAILABLE_FROM_TRUNCATED_SOURCE"}, indent=2))
            elif args.command == "cleanup":
                if args.older_than_hours < 0:
                    raise ContractError("Retention age must be nonnegative")
                removed = []
                for row in db.rows("SELECT a.*,t.spec FROM attempts a JOIN tasks t ON a.task_id=t.id WHERE a.status IN ('done','waiting') AND a.ended_at<? ORDER BY a.id", (time.time() - args.older_than_hours * 3600,)):
                    workspace = Workspace(root, TaskSpec.from_dict(json.loads(row["spec"])), row["id"], config)
                    if workspace.path.exists():
                        removed.append(row["id"])
                        if args.apply:
                            workspace.cleanup()
                if args.apply:
                    db.event("cleanup.applied", attempts=removed)
                print(json.dumps({"mode": "APPLY" if args.apply else "DRY_RUN", "eligible_owned_workspaces": removed,
                                  "source_files_deleted": 0, "failed_workspaces_deleted": 0}))
            elif args.command == "verify-experiment":
                print(json.dumps(validate_experiment(json.loads(args.file.read_text()), root), indent=2))
        return 0
    except KeyboardInterrupt:
        return 130
    except (ContractError, OSError, ValueError, KeyError, sqlite3.Error) as error:
        print(json.dumps({"state": "ERROR", "type": type(error).__name__, "detail": Redactor().text(str(error))}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
