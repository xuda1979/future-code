"""Bounded-fan-out ownership, a scoped task board, and deterministic rollups.

The board is a projection of durable records, not an LLM's global conversation.
There is no all-to-all broadcast and no LLM on the scheduling critical path.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import replace
import hashlib
import json
from typing import Any, Iterable

from .contracts import Config, ContractError, TaskSpec, identifier
from .store import Store, encode


def clip_utf8(text: str, maximum: int) -> str:
    """A display excerpt, never an authority-preserving contract transformation."""
    data = text.encode('utf-8')
    return text if len(data) <= maximum else data[:max(0, maximum - 3)].decode('utf-8', errors='ignore') + '...'


def build_hierarchy(leaves: list[TaskSpec], *, root_id: str = 'project-root', fanout: int = 8,
                    max_depth: int = 8, root_gates: Iterable[str] = ()) -> list[TaskSpec]:
    """Wrap an operator-provided flat DAG in a balanced tree of small integrators.

    This groups work; it does NOT invent a semantic decomposition of an objective.
    Dynamic decomposition uses the worker's independently bounded delegate action.
    Leaf contracts/dependencies are preserved. Internal nodes are read-only and
    receive direct-child cards; the root can run explicit integration gates.
    """
    identifier(root_id, 'root id')
    if type(fanout) is not int or (2 <= fanout <= 32):
        raise ContractError('Hierarchy fanout must be an integer in [2,32]')
    if type(max_depth) is not int or not 1 <= max_depth <= 8:
        raise ContractError('Hierarchy depth must be in [1,8]')
    if not leaves or len(leaves) > 100000:
        raise ContractError('Hierarchy requires 1..100000 leaf tasks')
    ids = {t.id for t in leaves}
    if len(ids) != len(leaves) or root_id in ids:
        raise ContractError('Leaf IDs must be unique and distinct from the root')
    if any(t.parent_id is not None or t.depth != 0 for t in leaves):
        raise ContractError('Hierarchy compiler requires unparented depth-zero leaves')
    Store._validate_graph({t.id: t.to_dict() for t in leaves})
    if len(leaves) > fanout ** max_depth:
        raise ContractError('Leaf count exceeds fanout ** max_depth')
    all_tasks = {t.id: replace(t) for t in leaves}
    layer = sorted(ids)
    level = 0
    namespace = hashlib.sha256(root_id.encode()).hexdigest()[:12]

    def make_node(node_id: str, children: list[str], gates: list[str]) -> None:
        if node_id in all_tasks:
            raise ContractError('Generated hierarchy ID collides with a supplied task ID')
        all_tasks[node_id] = TaskSpec(
            node_id, 'Integrate bounded group ' + node_id,
            'Check only your direct child result cards and their artifact/evidence references. '
            'Use inspect/result for specific detail; do not request all descendant transcripts. '
            'Reconcile interfaces and report unresolved uncertainty. Your finish statement is '
            'not a substitute for configured executable integration gates. Do not repeat child work.',
            dependencies=children, role='integrator', gates=gates,
            acceptance=['All direct child tasks finished; report concrete deliverables and limitations',
                        'All configured integration gates pass without weakening their inputs'],
            max_steps=12, priority=min(all_tasks[c].priority for c in children))
        for child in children:
            all_tasks[child] = replace(all_tasks[child], parent_id=node_id)

    while len(layer) > fanout:
        level += 1
        next_layer = []
        for offset in range(0, len(layer), fanout):
            node = f'h-{namespace}-{level}-{offset // fanout:06d}'
            make_node(node, layer[offset:offset + fanout], [])
            next_layer.append(node)
        layer = next_layer
    make_node(root_id, layer, list(root_gates))
    todo = [(root_id, 0)]
    while todo:
        node, depth = todo.pop()
        if depth > max_depth:
            raise ContractError('Hierarchy exceeds configured depth')
        all_tasks[node] = replace(all_tasks[node], depth=depth)
        if all_tasks[node].role == 'integrator' and node not in ids:
            todo.extend((child, depth + 1) for child in all_tasks[node].dependencies)
    result = [all_tasks[k] for k in sorted(all_tasks)]
    Store._validate_graph({t.id: t.to_dict() for t in result})
    return result


def rollups(tasks: list[dict]) -> dict[str, dict]:
    """O(nodes + ownership edges) numeric summaries; no prose summarization.

    leaf_checks_pass counts completed *leaves* with PASS on their configured
    gates. It neither proves a model summary nor substitutes for root gates.
    Cross-cell dependency edges do not duplicate leaf counts.
    """
    by_id = {t['id']: t for t in tasks}
    children: dict[str, list[str]] = defaultdict(list)
    for task in tasks:
        parent = task.get('parent_id')
        if parent in by_id:
            children[parent].append(task['id'])
    remaining = {key: len(children[key]) for key in by_id}
    ready = [key for key, count in remaining.items() if count == 0]
    result: dict[str, dict] = {}
    while ready:
        key = ready.pop()
        task = by_id[key]
        leaf = not children[key]
        done = task['status'] == 'done'
        passed = done and (task.get('result') or {}).get('quality') == 'PASS'
        values = {'direct_children': len(children[key]), 'descendants': 0,
                  'leaves': int(leaf), 'completed_leaves': int(leaf and done),
                  'leaf_checks_pass': int(leaf and passed),
                  'unknown_leaves': int(leaf and done and not passed),
                  'blocked_subtree': int(task['status'] in {'blocked', 'failed', 'cancelled'}),
                  'active_subtree': int(task['status'] == 'running')}
        for child in children[key]:
            values['descendants'] += 1 + result[child]['descendants']
            for field in ('leaves', 'completed_leaves', 'leaf_checks_pass', 'unknown_leaves', 'blocked_subtree', 'active_subtree'):
                values[field] += result[child][field]
        values['leaf_gate_coverage'] = ('PASS' if values['leaves'] and values['leaf_checks_pass'] == values['leaves'] else 'UNKNOWN')
        result[key] = values
        parent = task.get('parent_id')
        if parent in remaining:
            remaining[parent] -= 1
            if remaining[parent] == 0:
                ready.append(parent)
    if len(result) != len(tasks):
        raise ContractError('Cannot roll up cyclic or duplicate ownership records')
    return result


class Coordination:
    """Task-local access to a shared durable board, with explicit pagination."""
    def __init__(self, db: Store, config: Config):
        self.db, self.config = db, config

    def related_ids(self, task_id: str, relation: str) -> list[str]:
        task = self.db.task(task_id)
        if relation == 'children':
            ids = [r['id'] for r in self.db.rows('SELECT id FROM tasks WHERE parent_id=? ORDER BY id', (task_id,))]
        elif relation == 'parent':
            ids = [task['parent_id']] if task['parent_id'] else []
        elif relation == 'dependencies':
            ids = task['spec']['dependencies']
        elif relation == 'peers':
            ids = ([r['id'] for r in self.db.rows('SELECT id FROM tasks WHERE parent_id=? AND id<>? ORDER BY id',
                                                 (task['parent_id'], task_id))] if task['parent_id'] else [])
        elif relation == 'dependents':
            ids = [r['id'] for r in self.db.rows('SELECT id,spec FROM tasks') if task_id in json.loads(r['spec'])['dependencies']]
        else:
            raise ContractError('relation must be children, parent, dependencies, peers or dependents')
        return sorted(set(ids))

    def allowed(self, sender: str, recipient: str) -> bool:
        if sender == recipient:
            return True
        return any(recipient in self.related_ids(sender, relation) for relation in
                   ('parent', 'children', 'dependencies', 'peers', 'dependents'))

    def descendant(self, ancestor: str, task_id: str) -> bool:
        """Ownership traversal for selective reads, never broadcast permission."""
        seen: set[str] = set()
        cursor: str | None = task_id
        while cursor is not None and cursor not in seen:
            if cursor == ancestor:
                return True
            seen.add(cursor)
            cursor = self.db.task(cursor)['parent_id']
        return False

    def readable(self, requester: str, task_id: str) -> bool:
        return self.allowed(requester, task_id) or self.descendant(requester, task_id)

    def subtree_counts(self, task_id: str) -> dict:
        # UNION (not UNION ALL) also terminates on an externally corrupted cycle.
        rows = self.db.rows("""WITH RECURSIVE subtree(id) AS (
            SELECT id FROM tasks WHERE id=? UNION
            SELECT t.id FROM tasks t JOIN subtree s ON t.parent_id=s.id)
            SELECT t.id,t.parent_id,t.status,t.result FROM tasks t JOIN subtree s ON t.id=s.id""", (task_id,))
        for row in rows:
            row['result'] = json.loads(row['result']) if row['result'] else None
        data = rollups(rows)[task_id]
        return {k: data[k] for k in ('leaves', 'completed_leaves', 'leaf_checks_pass',
                                     'unknown_leaves', 'blocked_subtree', 'leaf_gate_coverage')}

    def card(self, task_id: str) -> dict:
        row = self.db.task(task_id)
        result = row['result'] or {}
        return {'id': row['id'], 'role': row['spec']['role'], 'status': row['status'],
                'quality': result.get('quality', 'UNKNOWN'),
                'quality_scope': 'configured executable gates on recorded inputs only',
                'summary_unverified': clip_utf8(str(result.get('model_summary', '')), 320),
                'uncertainties_unverified': [clip_utf8(str(x), 160) for x in result.get('uncertainties', [])[:2]],
                'uncertainties_total': len(result.get('uncertainties', [])),
                'blocker': clip_utf8(row.get('error', ''), 200),
                'result_reference': task_id,
                'evidence_count': len(result.get('gate_evidence', [])),
                'artifact_count': len(result.get('artifacts', [])),
                'subtree_counts': self.subtree_counts(task_id),
                'updated_at': row['updated_at']}

    def inspect(self, task_id: str, *, relation: str, after: str = '', limit: int | None = None,
                target: str | None = None) -> dict:
        limit = self.config.context_items if limit is None else limit
        if type(limit) is not int or not 1 <= limit <= self.config.context_items or not isinstance(after, str):
            raise ContractError('Invalid task-board page; use configured context_items or fewer')
        target = task_id if target is None else target
        if not isinstance(target, str) or not self.descendant(task_id, target):
            raise ContractError('Inspect target must be self or an owned descendant')
        ids = self.related_ids(target, relation)
        eligible = [key for key in ids if key > after]
        selected = eligible[:limit]
        return {'inspected_task': target, 'relation': relation, 'total': len(ids), 'items': [self.card(key) for key in selected],
                'next_after': selected[-1] if len(eligible) > limit else None,
                'snapshot': 'current database observations; model summaries remain unverified'}

    def local_policy(self, task: TaskSpec) -> dict:
        child_count = self.db.conn.execute('SELECT COUNT(*) FROM tasks WHERE parent_id=?', (task.id,)).fetchone()[0]
        return {'pattern': 'hierarchical-task-mesh', 'parent_id': task.parent_id,
                'depth': task.depth, 'direct_children': child_count,
                'lifetime_child_limit': self.config.max_children,
                'remaining_child_slots': max(0, self.config.max_children - child_count),
                'depth_limit': self.config.max_delegation_depth,
                'board_page_size': self.config.context_items,
                'routing': 'parent, direct children, siblings, explicit dependency endpoints only',
                'manager_resume': 'fresh task-local context after children finish; no descendant transcripts'}

    def send(self, sender: str, fence: int, recipient: str, content: str) -> None:
        identifier(recipient, 'recipient')
        if not isinstance(content, str) or not content.strip() or len(content.encode()) > self.config.max_message_bytes:
            raise ContractError('Message exceeds configured UTF-8 byte ceiling or is empty')
        # Admission and append are a single transaction, including inbox capacity.
        with self.db.transaction():
            self.db.assert_owner(sender, fence)
            target = self.db.task(recipient)
            if target['status'] in {'done', 'failed', 'cancelled'}:
                raise ContractError('Recipient is terminal; route an unresolved issue to a live related coordinator')
            if self.config.scoped_messages and not self.allowed(sender, recipient):
                raise ContractError('No collaboration edge: use your parent or an explicit dependency')
            cursor = self.db.memory(recipient)['delivered_seq']
            pending = self.db.conn.execute('SELECT COUNT(*) FROM messages WHERE recipient=? AND seq>?', (recipient, cursor)).fetchone()[0]
            if pending >= self.config.max_inbox_pending:
                raise ContractError('Recipient inbox is full; coalesce the finding or escalate, do not broadcast')
            count = self.db.conn.execute('SELECT COUNT(*) FROM messages WHERE sender=?', (sender,)).fetchone()[0]
            if count >= 100:
                raise ContractError('Per-task message ceiling reached')
            import time
            self.db.conn.execute('INSERT INTO messages(sender,recipient,content,created_at) VALUES(?,?,?,?)',
                                 (sender, recipient, content, time.time()))
            self.db.event('message.sent', sender, recipient=recipient, routing='scoped')

    def evidence_card(self, task_id: str, evidence_id: str) -> dict:
        rows = self.db.rows('SELECT * FROM evidence WHERE id=? AND task_id=?', (evidence_id, task_id))
        if not rows:
            return {'evidence_id': evidence_id, 'record_status': 'MISSING', 'verdict': 'UNKNOWN'}
        row = rows[0]
        # The full log remains an operator artifact; large tool results are not
        # silently injected into another agent's prompt. Details are labeled.
        return {'evidence_id': evidence_id, 'record_status': 'RECORDED',
                'kind': row['kind'], 'verdict': row['verdict'], 'fingerprint': row['fingerprint'],
                'artifact_reference': row['path'], 'created_at': row['created_at'],
                'details_excerpt_untrusted': clip_utf8(row['details'], 1600),
                'details_truncated': len(row['details'].encode()) > 1600}

    def result_page(self, requester: str, task_id: str, *, after: str = '', limit: int | None = None,
                    section: str = 'artifacts') -> dict:
        identifier(requester, 'requester')
        identifier(task_id, 'result task id')
        if not isinstance(section, str):
            raise ContractError('Result section must be text')
        if not self.readable(requester, task_id):
            raise ContractError('Result is outside the local collaboration graph')
        limit = self.config.context_items if limit is None else limit
        if type(limit) is not int or not 1 <= limit <= self.config.context_items or not isinstance(after, str):
            raise ContractError('Invalid result page')
        row = self.db.task(task_id)
        result = row['result'] or {}
        if section == 'artifacts':
            items = sorted(result.get('artifacts', []), key=lambda a: a['path'])
            keys = [item['path'] for item in items]
            start = next((i for i, key in enumerate(keys) if key > after), len(keys))
        elif section in {'evidence', 'uncertainties', 'summary'}:
            if section == 'evidence':
                items = [self.evidence_card(task_id, key) for key in result.get('gate_evidence', [])]
            elif section == 'uncertainties':
                items = [{'uncertainty_unverified': text} for text in result.get('uncertainties', [])]
            else:
                items = [{'summary_unverified': result['model_summary']}] if 'model_summary' in result else []
            if after and (not after.isascii() or not after.isdigit() or len(after)>8):
                raise ContractError('This result section requires an integer offset cursor')
            start = int(after) if after else 0
            keys = [str(i+1) for i in range(len(items))]
        else:
            raise ContractError('Result section must be artifacts, evidence, uncertainties or summary')
        selected = []
        for item in items[start:start+limit]:
            if selected and len(encode(selected + [item]).encode()) > 4000:
                break
            selected.append(item)
        end = start + len(selected)
        return {'card': self.card(task_id), 'section': section, 'total': len(items), 'items': selected,
                'next_after': keys[end-1] if selected and end < len(items) else None,
                'verification_scope': 'artifact hashes at integration, not current file reauthentication or proof of prose claims'}
