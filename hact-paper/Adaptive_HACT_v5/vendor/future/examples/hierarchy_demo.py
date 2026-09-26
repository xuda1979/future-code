#!/usr/bin/env python3
"""Run a real hierarchical scheduler with a SCRIPTED model, not a hosted LLM.

The output directory must be empty. No credentials, network or paid API is used.
Measures execution and input-context bounds, not reasoning or repair quality.
"""
from __future__ import annotations

import argparse
import asyncio
from collections import Counter
import json
from pathlib import Path
import time

from future_code.context import request_size
from future_code.contracts import Config, ContractError, TaskSpec
from future_code.coordination import build_hierarchy
from future_code.runtime import Supervisor
from future_code.security import Redactor, atomic_write, ensure_control
from future_code.store import Store


class ScriptedBackend:
    """Synthetic latency permits overlapping requests; measurements are real."""
    def __init__(self, delay: float = 0.005):
        self.delay = delay
        self.active = self.peak = 0
        self.redactor = Redactor()
        self.requests: list[dict] = []

    async def complete(self, messages: list[dict], task_id: str, workspace: Path | None = None) -> str:
        packet = json.loads(messages[1]['content'])
        self.requests.append({'task_id': task_id, 'role': packet['task']['role'],
                              'depth': packet['task']['depth'], **request_size(messages),
                              'dependency_cards': len(packet['dependencies']),
                              'dependency_total': packet['dependency_index']['total']})
        self.active += 1
        self.peak = max(self.peak, self.active)
        try:
            await asyncio.sleep(self.delay)
            return json.dumps({'action': 'finish', 'summary': 'Synthetic local task completed: ' + task_id,
                               'uncertainties': ['Scripted response, not model reasoning; no semantic acceptance gate configured']})
        finally:
            self.active -= 1

    async def probe(self) -> None:
        return None

    async def close(self) -> None:
        return None


async def exercise(root: Path, *, leaves: int = 512, fanout: int = 8, workers: int = 64) -> dict:
    tasks = build_hierarchy([TaskSpec(f'leaf-{i:05d}', 'Independent fixture shard',
                                     'Inspect only the assigned synthetic shard; do not claim semantic correctness')
                             for i in range(leaves)], fanout=fanout, max_depth=8)
    config = Config(max_workers=workers, max_children=fanout, max_delegation_depth=8,
                    max_total_tasks=max(500, len(tasks)), max_active_per_cell=min(4, fanout),
                    max_requests=max(1000, len(tasks) * 2), max_reserved_tokens=100_000_000,
                    heartbeat_seconds=0.5, lease_seconds=60, stale_seconds=60,
                    poll_seconds=0.005, minimum_free_bytes=0)
    if root.exists() and any(root.iterdir()):
        raise ValueError('Output must be empty or nonexistent; no existing project was changed')
    root.mkdir(parents=True, exist_ok=True)
    control = ensure_control(root)
    atomic_write(control / 'config.json', json.dumps(config.to_dict(), indent=2).encode())
    with Store(control / 'state.db') as db:
        db.add_tasks(tasks, max_total=config.max_total_tasks)
    backend = ScriptedBackend()
    supervisor = Supervisor(root, config, backend=backend)
    started = time.perf_counter()
    async with asyncio.timeout(180):
        outcome = await supervisor.run(until_idle=True)
    elapsed = time.perf_counter() - started
    with Store(control / 'state.db', readonly=True) as db:
        rows = db.tasks()
        audit_count = db.conn.execute('SELECT COUNT(*) FROM context_usage').fetchone()[0]
        incidents = db.rows('SELECT category,severity,count FROM issues')
    states = Counter(row['status'] for row in rows)
    quality = Counter((row['result'] or {}).get('quality', 'UNKNOWN') for row in rows)
    children = Counter(t.parent_id for t in tasks if t.parent_id)
    coordinators = [r for r in backend.requests if r['role'] == 'integrator']
    root_requests = [r for r in backend.requests if r['task_id'] == 'project-root']
    passed = (states == {'done': len(tasks)} and len(backend.requests) == len(tasks)
              and audit_count == len(tasks) and max(children.values()) <= fanout
              and all(r['utf8_bytes'] <= config.max_context_bytes and r['dependency_cards'] <= fanout
                      for r in backend.requests))
    record = {'schema_version': 1, 'verdict': 'PASS' if passed else 'FAIL',
              'scope': 'SCRIPTED model; real scheduler, database, workspaces, integration and context admission',
              'logical_tasks': len(tasks), 'leaf_tasks': leaves, 'integrators': len(tasks)-leaves,
              'fanout_limit': fanout, 'observed_max_direct_children': max(children.values()),
              'tree_depth': max(t.depth for t in tasks), 'configured_worker_slots': workers,
              'peak_active_workers': outcome['peak_workers'], 'peak_overlapping_model_requests': backend.peak,
              'model_requests': len(backend.requests), 'context_audit_records': audit_count,
              'context_input_byte_limit': config.max_context_bytes,
              'peak_request_bytes': max(r['utf8_bytes'] for r in backend.requests),
              'peak_coordinator_request_bytes': max(r['utf8_bytes'] for r in coordinators),
              'max_coordinator_dependency_cards': max(r['dependency_cards'] for r in coordinators),
              'root_requests': root_requests, 'task_states': dict(states), 'task_quality': dict(quality),
              'elapsed_seconds': round(elapsed, 4), 'incidents': incidents,
              'hosted_llm_evaluation': 'NOT_RUN', 'token_count': 'UNKNOWN',
              'note': 'Read-only fixture task quality is UNKNOWN by design. Topology capacity is not concurrent agent count. '
                      'Timing is a single local synthetic run, not a production throughput or speedup benchmark.'}
    atomic_write(control / 'reports/hierarchy-result.json', json.dumps(record, indent=2).encode())
    atomic_write(control / 'reports/context-measurements.json', json.dumps(backend.requests, indent=2).encode())
    if not passed:
        raise ContractError('Hierarchy exercise failed; inspect the saved reports and incidents')
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--leaves', type=int, default=512)
    parser.add_argument('--fanout', type=int, default=8)
    parser.add_argument('--workers', type=int, default=64)
    args = parser.parse_args()
    print(json.dumps(asyncio.run(exercise(args.output.resolve(), leaves=args.leaves,
                                          fanout=args.fanout, workers=args.workers)), indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
