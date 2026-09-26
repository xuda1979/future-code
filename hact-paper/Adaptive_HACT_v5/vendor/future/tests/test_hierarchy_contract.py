"""Acceptance contracts established before the hierarchical implementation."""
import json
import pytest
from future_code.contracts import Config, ContractError, TaskSpec
from future_code.coordination import build_hierarchy, Coordination
from future_code.context import build_context, request_size
from future_code.worker import SYSTEM


def test_512_leaves_have_bounded_recursive_fanout():
    leaves = [TaskSpec(f'leaf-{i:04}', 'Read one shard', 'Inspect only the assigned shard') for i in range(512)]
    tasks = build_hierarchy(leaves, fanout=8, root_id='root', max_depth=3)
    by_id = {t.id: t for t in tasks}
    assert len(tasks) == 585
    assert max(t.depth for t in tasks) == 3
    assert len(by_id['root'].dependencies) == 8
    assert all(len(t.dependencies) <= 8 for t in tasks)
    assert sum(t.role == 'integrator' for t in tasks) == 73


def test_delegation_does_not_consume_failure_attempt_and_fanout_is_cumulative(db):
    db.add_tasks([TaskSpec('p', 'Parent', 'Divide', max_attempts=1)])
    p = db.claim('one')
    db.delegate('p', p['fence'], [TaskSpec('c', 'Child', 'Work', parent_id='p', depth=1)], max_total=10, max_children=1)
    c = db.claim('two'); assert c['id'] == 'c'
    db.finish('c', c['fence'], 'done')
    p = db.claim('three'); assert p['id'] == 'p'
    with pytest.raises(ContractError):
        db.delegate('p', p['fence'], [TaskSpec('d', 'Child', 'Work', parent_id='p', depth=1)], max_total=10, max_children=1)
    assert len(db.tasks()) == 2


def test_utf8_bound_and_contract_preservation():
    c = Config(max_context_bytes=6000)
    t = TaskSpec('small', 'Small', 'Keep acceptance intact', acceptance=['Never weaken this condition'])
    packet = build_context(t, c, SYSTEM, [{'result': '\U0001f9e0' * 8000}], [], [])
    assert request_size(packet.messages)['utf8_bytes'] <= 6000
    assert 'Never weaken this condition' in json.dumps(packet.messages)
    with pytest.raises(ContractError):
        build_context(TaskSpec('big', 'Big', '\U0001f9e0' * 4000), c, SYSTEM, [], [], [])


def test_scoped_board_has_no_global_transcript(db):
    tasks = build_hierarchy([TaskSpec(f't{i}', 'T', 'Work') for i in range(16)], fanout=4, root_id='root')
    db.add_tasks(tasks)
    board = Coordination(db, Config())
    page = board.inspect('root', relation='children', limit=4)
    assert len(page['items']) == 4
    assert all('instructions' not in item for item in page['items'])
    assert page['total'] == 4
