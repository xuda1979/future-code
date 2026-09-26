"""Adversarial and lifecycle tests for the actual coordination implementation."""
from __future__ import annotations

import asyncio
from collections import Counter
from dataclasses import replace
import json
import random
import sqlite3
import time

import pytest

from conftest import ScriptBackend, queue
from future_code.cli import main
from future_code.context import build_context, enforce_bounds, request_size
from future_code.contracts import Config, ContractError, FencedError, TaskSpec
from future_code.coordination import Coordination, build_hierarchy, rollups
from future_code.reporting import TABLES, render_html, render_markdown, snapshot
from future_code.runtime import Supervisor
from future_code.store import Store
from future_code.transport import TemporaryEndpointError
from future_code.worker import SYSTEM, Worker, parse_action

FINISH = {'action': 'finish', 'summary': 'Fixture task complete', 'uncertainties': ['Scripted model; no semantic quality claim']}


def tree(n=16, fanout=4):
    return build_hierarchy([TaskSpec(f'leaf-{i:03d}', 'Leaf', 'Read one independent shard') for i in range(n)],
                           root_id='root', fanout=fanout)


@pytest.mark.parametrize('n,fanout', [(1,2),(2,2),(3,2),(8,8),(9,8),(16,4),(63,4),(512,8),(4096,8)])
def test_hierarchy_preserves_leaf_contracts_and_has_correct_depth(n, fanout):
    leaves = [TaskSpec(f'L-{i:05d}', 'Original objective', 'Original instructions', acceptance=['Original gate']) for i in range(n)]
    original = [t.to_dict() for t in leaves]
    tasks = build_hierarchy(leaves, fanout=fanout)
    assert [t.to_dict() for t in leaves] == original
    by_id = {t.id:t for t in tasks}
    children = Counter(t.parent_id for t in tasks if t.parent_id)
    assert max(children.values()) <= fanout
    for t in tasks:
        assert t.depth == (by_id[t.parent_id].depth + 1 if t.parent_id else 0)
    for old in leaves:
        t = by_id[old.id]
        assert replace(t, parent_id=None, depth=0).to_dict() == old.to_dict()


@pytest.mark.parametrize('kwargs', [{'fanout':1},{'fanout':True},{'fanout':33},{'max_depth':0},{'max_depth':9},
                                   {'root_id':'bad/id'},{'root_id':'leaf-000'}])
def test_invalid_hierarchy_parameters_fail(kwargs):
    with pytest.raises(ContractError):
        build_hierarchy([TaskSpec('leaf-000','Leaf','Work')], **kwargs)


def test_hierarchy_rejects_excess_depth_cycles_duplicates_and_existing_parents():
    with pytest.raises(ContractError): build_hierarchy([])
    a = TaskSpec('a','A','A')
    with pytest.raises(ContractError): build_hierarchy([a,a])
    with pytest.raises(ContractError): build_hierarchy([replace(a,parent_id='old')])
    with pytest.raises(ContractError): build_hierarchy([replace(a,dependencies=['missing'])])
    with pytest.raises(ContractError): build_hierarchy([TaskSpec(str(i),'L','L') for i in range(9)],fanout=2,max_depth=3)
    with pytest.raises(ContractError): build_hierarchy([replace(a,dependencies=['b']),TaskSpec('b','B','B',dependencies=['a'])])


def test_parent_graph_cycle_and_missing_parent_rejected_atomically(db):
    with pytest.raises(ContractError):
        db.add_tasks([TaskSpec('a','A','A',parent_id='b'),TaskSpec('b','B','B',parent_id='a')])
    with pytest.raises(ContractError): db.add_tasks([TaskSpec('a','A','A',parent_id='missing')])
    assert db.tasks() == []


def test_scoped_board_pages_are_stable_and_prevent_unrelated_reads(db):
    db.add_tasks(tree())
    board = Coordination(db, Config(context_items=2))
    first = board.inspect('root',relation='children')
    second = board.inspect('root',relation='children',after=first['next_after'])
    assert len(first['items']) == len(second['items']) == 2
    assert second['next_after'] is None
    assert not {r['id'] for r in first['items']} & {r['id'] for r in second['items']}
    assert board.related_ids('root','peers') == []
    assert board.related_ids('root','parent') == []
    assert board.related_ids('leaf-000','peers') == ['leaf-001','leaf-002','leaf-003']
    assert not board.allowed('leaf-000','leaf-010')
    with pytest.raises(ContractError): board.result_page('leaf-000','leaf-010')
    with pytest.raises(ContractError): board.inspect('root',relation='all')
    with pytest.raises(ContractError): board.inspect('root',relation='children',limit=3)
    with pytest.raises(ContractError): board.inspect('root',relation='children',after=[])


def test_cross_cell_dependencies_are_explicit_allowed_edges(db):
    tasks = tree()
    tasks = [replace(t,dependencies=['leaf-000']) if t.id=='leaf-010' else t for t in tasks]
    db.add_tasks(tasks)
    board = Coordination(db, Config())
    assert board.allowed('leaf-000','leaf-010')
    assert board.allowed('leaf-010','leaf-000')
    assert 'leaf-010' in board.related_ids('leaf-000','dependents')
    assert board.related_ids('leaf-010','dependencies') == ['leaf-000']


def test_mailbox_scope_capacity_utf8_and_terminal_recipient(db):
    db.add_tasks(tree())
    board = Coordination(db, Config(max_inbox_pending=2,max_message_bytes=100))
    claim = db.claim('worker')
    sender = claim['id']; peer = board.related_ids(sender,'peers')[0]
    with pytest.raises(ContractError): board.send(sender,claim['fence'],'leaf-015','not a neighbor')
    with pytest.raises(ContractError): board.send(sender,claim['fence'],peer,'\U0001f9e0'*26)
    board.send(sender,claim['fence'],peer,'first')
    board.send(sender,claim['fence'],peer,'second')
    with pytest.raises(ContractError): board.send(sender,claim['fence'],peer,'third')
    assert len(db.messages(peer)) == 2
    db.conn.execute("UPDATE tasks SET status='done' WHERE id=?", (peer,))
    with pytest.raises(ContractError): board.send(sender,claim['fence'],peer,'too late')


def test_notes_are_replace_only_versioned_fenced_and_bounded(db):
    db.add_tasks([TaskSpec('a','A','A')]); a=db.claim('one')
    first=db.write_note('a',a['fence'],'first',expected_revision=0)
    assert first['revision']==1
    with pytest.raises(ContractError): db.write_note('a',a['fence'],'lost update',expected_revision=0)
    second=db.write_note('a',a['fence'],'second',expected_revision=1)
    assert second['note']=='second' and second['revision']==2
    with pytest.raises(ContractError): db.write_note('a',a['fence'],'\U0001f9e0'*500,max_bytes=1000)
    db.conn.execute("UPDATE tasks SET lease_until=0 WHERE id='a'")
    with pytest.raises(FencedError): db.write_note('a',a['fence'],'stale')


def test_delivery_cursor_validates_recipient_and_cannot_move_backwards(db):
    db.add_tasks([TaskSpec('a','A','A'),TaskSpec('b','B','B')]);a=db.claim('one');b=db.claim('two')
    db.send_message('a',a['fence'],'b','one'); db.send_message('a',a['fence'],'b','two')
    seq=db.messages('b')[-1]['seq']
    db.mark_delivered('b',b['fence'],seq)
    db.mark_delivered('b',b['fence'],0)
    assert db.memory('b')['delivered_seq']==seq
    with pytest.raises(ContractError): db.mark_delivered('a',a['fence'],seq)
    with pytest.raises(ContractError): db.mark_delivered('b',b['fence'],-1)


def test_byte_fuzzer_and_omission_accounting():
    rng=random.Random(139)
    for _ in range(120):
        budget=rng.randrange(6500,18000)
        config=Config(max_context_bytes=budget)
        history=[{'result':rng.choice(['x','\U0001f9e0','\u6570'])*rng.randrange(10,6000)} for _ in range(rng.randrange(15))]
        deps=[{'id':f'd{i}','status':'done','quality':'UNKNOWN','summary_unverified':'\U0001f9e0'*300} for i in range(40)]
        task=TaskSpec('a','A','Do not weaken acceptance',dependencies=[d['id'] for d in deps])
        mail=[{'seq':i+1,'sender':'peer','content':'x'*900} for i in range(15)]
        packet=build_context(task,config,SYSTEM,history,deps,mail)
        assert request_size(packet.messages)['utf8_bytes']<=budget
        body=json.loads(packet.messages[1]['content'])
        shown=body['messages']
        assert [m['seq'] for m in shown]==list(range(1,len(shown)+1))
        assert packet.delivered_through==(shown[-1]['seq'] if shown else 0)
        assert body['omitted']['messages']+len(shown)==15
        assert body['omitted']['dependency_cards']+len(body['dependencies'])==40
        assert len(body['task']['dependencies'])<=config.context_items
        assert body['task']['instructions']==task.instructions
        assert body['task']['acceptance']==task.acceptance


def test_huge_unused_gate_registry_does_not_enter_context():
    from future_code.contracts import GateSpec
    c=Config(gates={f'g-{i}':GateSpec(['true']) for i in range(4000)})
    packet=build_context(TaskSpec('a','A','A'),c,SYSTEM,[],[],[])
    assert json.loads(packet.messages[1]['content'])['available_gate_ids']==[]
    enforce_bounds(packet.messages,c)


def test_fair_share_limits_active_siblings_without_losing_global_bug_priority(db):
    db.add_tasks(tree(16))
    claims=[db.claim(f'w-{i}',max_active_per_cell=1) for i in range(4)]
    parents=[r['parent_id'] for r in claims]
    assert len(set(parents))==4
    assert db.claim('overflow',max_active_per_cell=1) is None
    for c in claims: db.finish(c['id'],c['fence'],'done')
    assert db.claim('next',max_active_per_cell=1) is not None


def test_rollups_count_leaves_once_not_cross_dependency_edges(db):
    tasks=tree(16);tasks=[replace(t,dependencies=['leaf-000']) if t.id=='leaf-010' else t for t in tasks]
    db.add_tasks(tasks)
    db.conn.execute("UPDATE tasks SET status='done',result=? WHERE id LIKE 'leaf-%'", (json.dumps({'quality':'PASS'}),))
    data=rollups(db.tasks())
    assert data['root']['leaves']==16
    assert data['root']['leaf_checks_pass']==16
    assert data['root']['descendants']==20
    db.conn.execute("UPDATE tasks SET result=NULL WHERE id='leaf-003'")
    data=rollups(db.tasks())
    assert data['root']['leaf_gate_coverage']=='UNKNOWN'
    assert data['root']['unknown_leaves']==1
    db.conn.execute("UPDATE tasks SET status='blocked' WHERE id='leaf-004'")
    assert rollups(db.tasks())['root']['blocked_subtree']==1


def test_v1_database_migration_preserves_tasks_and_events(tmp_path):
    path=tmp_path/'db'
    with Store(path) as db:
        db.add_tasks([TaskSpec('legacy','Legacy','Unchanged')])
        db.conn.execute('DROP TABLE task_memory');db.conn.execute('DROP TABLE context_usage')
        db.set_meta('schema_version',1)
        expected=db.task('legacy'); old_events=db.rows('SELECT * FROM events')
    with Store(path) as db:
        assert db.get_meta('schema_version')==2
        assert db.task('legacy')==expected
        assert db.rows('SELECT * FROM events')==old_events
        assert db.memory('legacy')['delivered_seq']==0


def test_readonly_status_can_read_legacy_database_without_migration(tmp_path):
    path=tmp_path/'db'
    with Store(path) as db:
        db.add_tasks([TaskSpec('a','A','A')]);db.set_meta('schema_version',1)
        db.conn.execute('DROP TABLE task_memory');db.conn.execute('DROP TABLE context_usage')
    with Store(path,readonly=True) as db:
        report=snapshot(db)
        assert report['schema_version']==2
        assert report['tables']['contexts']==[]
        assert db.get_meta('schema_version')==1


async def test_dynamic_tree_85_tasks_rehydrates_local_managers(tmp_path,config):
    config.max_workers=16;config.max_total_tasks=100;config.max_children=4
    queue(tmp_path,[TaskSpec('root','Coordinate','Divide into four independent tasks recursively',role='coordinator',max_attempts=1)])
    class Dynamic(ScriptBackend):
        async def complete(self,messages,task_id,workspace=None):
            self.requests.append((task_id,messages,workspace))
            self.active+=1;self.peak=max(self.peak,self.active)
            await asyncio.sleep(.001)
            self.active-=1
            packet=json.loads(messages[1]['content']);spec=packet['task']
            if spec['depth']<3 and not spec['dependencies']:
                return json.dumps({'action':'delegate','tasks':[
                    {'id':task_id+f'.{i}','title':'Bounded child','instructions':'Divide if depth is below three; otherwise inspect your shard',
                     'role':'coordinator' if spec['depth']<2 else 'builder'} for i in range(4)]})
            return json.dumps(FINISH)
    backend=Dynamic()
    result=await Supervisor(tmp_path,config,backend=backend).run(until_idle=True)
    assert len(result['task_states'])==85 and set(result['task_states'].values())=={'done'}
    assert backend.peak>=4
    with Store(tmp_path/'.future-code/state.db') as db:
        reports=snapshot(db)
        assert len(reports['tables']['hierarchy'])==21
        assert db.task('root')['attempts']==1
        assert len(db.rows('SELECT * FROM context_usage'))==106
    root_packets=[json.loads(m[1]['content']) for t,m,_ in backend.requests if t=='root']
    assert len(root_packets)==2
    assert len(root_packets[1]['dependencies'])==4
    assert len(root_packets[1].get('recent_observations',[]))==1 # fresh workspace, no prior transcript
    for _,messages,_ in backend.requests:
        assert request_size(messages)['utf8_bytes']<=config.max_context_bytes
        assert len(json.loads(messages[1]['content'])['dependencies'])<=4


async def test_working_note_survives_yield_but_old_transcript_does_not(tmp_path,config):
    queue(tmp_path,[TaskSpec('p','P','Delegate one',max_attempts=1)])
    child={'id':'c','title':'C','instructions':'Read'}
    backend=ScriptBackend({'p':[{'action':'remember','note':'Interface ABI v3; see acceptance inputs','expected_revision':0},
                                {'action':'delegate','tasks':[child]},FINISH]})
    result=await Supervisor(tmp_path,config,backend=backend).run(until_idle=True)
    assert set(result['task_states'].values())=={'done'}
    packet=json.loads([m for task,m,_ in backend.requests if task=='p'][-1][1]['content'])
    assert packet['working_note']['note_unverified'].startswith('Interface ABI v3')
    assert packet['working_note']['revision']==1
    assert all(obs.get('action')!='remember' for obs in packet['recent_observations'])


async def test_pending_mail_is_not_acknowledged_on_failed_request(tmp_path,config):
    queue(tmp_path,[TaskSpec('a','A','A'),TaskSpec('b','B','B',dependencies=['a'])])
    with Store(tmp_path/'.future-code/state.db') as db:
        a=db.claim('a');db.send_message('a',a['fence'],'b','IMPORTANT CONTRACT');db.finish('a',a['fence'],'done')
    backend=ScriptBackend({'b':[TemporaryEndpointError('outage',1)]})
    result=await Supervisor(tmp_path,config,backend=backend).run(until_idle=True)
    assert result['task_states']['b']=='retry_wait'
    with Store(tmp_path/'.future-code/state.db') as db:
        assert db.memory('b')['delivered_seq']==0
        db.conn.execute("UPDATE tasks SET available_at=0 WHERE id='b'")
    second=ScriptBackend()
    await Supervisor(tmp_path,config,backend=second).run(until_idle=True)
    assert 'IMPORTANT CONTRACT' in json.dumps(second.requests[0][1])
    with Store(tmp_path/'.future-code/state.db') as db:
        assert db.memory('b')['delivered_seq']>0


async def test_results_and_inbox_tools_are_exercised_in_actual_worker(tmp_path,config):
    queue(tmp_path,[TaskSpec('a','A','Read'),TaskSpec('b','B','Inspect predecessor',dependencies=['a'])])
    backend=ScriptBackend({'a':[FINISH], 'b':[
        {'action':'inspect','relation':'dependencies','limit':1},
        {'action':'result','task_id':'a','limit':1},
        {'action':'inbox','after':0,'limit':1},FINISH]})
    result=await Supervisor(tmp_path,config,backend=backend).run(until_idle=True)
    assert set(result['task_states'].values())=={'done'}
    assert 'quality_scope' in json.dumps([m for _,m,_ in backend.requests])


async def test_new_status_schema_has_fixed_tables_with_measured_context(tmp_path,config):
    queue(tmp_path,tree(4))
    await Supervisor(tmp_path,config,backend=ScriptBackend()).run(until_idle=True)
    with Store(tmp_path/'.future-code/state.db') as db:
        data=snapshot(db)
    assert len(TABLES)==13
    for name,rows in data['tables'].items():
        assert all(set(row)=={key for key,_ in TABLES[name]} for row in rows)
    assert all(c['bounds']=='PASS' for c in data['tables']['contexts'])
    assert data['tables']['hierarchy'][0]['unknown']==4
    assert data['tables']['hierarchy'][0]['own_quality']=='UNKNOWN'
    assert render_markdown(data).count('\n## ')==13
    assert render_html(data).count('<section ')==13


def test_cli_hierarchy_submission(tmp_path,capsys):
    prefix=['--project',str(tmp_path)]
    assert main(prefix+['init'])==0
    tasks=tmp_path/'tasks.json'; tasks.write_text(json.dumps({'tasks':[TaskSpec(f'L{i}','Leaf','Read').to_dict() for i in range(16)]}))
    assert main(prefix+['submit',str(tasks),'--hierarchy','--fanout','4','--root-id','root'])==0
    with Store(tmp_path/'.future-code/state.db') as db:
        assert len(db.tasks())==21
        assert len(db.task('root')['spec']['dependencies'])==4
    capsys.readouterr()


@pytest.mark.parametrize('fields',[{'max_context_bytes':4095},{'context_items':0},{'max_active_per_cell':0},
                                   {'max_inbox_pending':0},{'max_note_bytes':50},{'scoped_messages':'true'}])
def test_new_configuration_is_strict(fields):
    with pytest.raises(ContractError): Config(**fields)
