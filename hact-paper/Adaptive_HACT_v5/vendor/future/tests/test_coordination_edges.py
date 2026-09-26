"""Information-retention and admission regressions, including real tool paths."""
from __future__ import annotations
import asyncio
import hashlib
import json
import sys
from pathlib import Path

import httpx
import pytest

from conftest import ScriptBackend
from future_code.contracts import Config, ContractError, TaskSpec
from future_code.coordination import Coordination
from future_code.transport import HTTPBackend, CommandBackend
from future_code.worker import Worker


def stored_result(db):
    db.add_tasks([TaskSpec('a','A','A'),TaskSpec('b','B','B',dependencies=['a'])])
    result={'quality':'PASS', 'model_summary':'Original full summary ' + 'x'*1500,
            'uncertainties':['uncertainty-'+str(i)+'x'*250 for i in range(20)],
            'gate_evidence':[f'evidence-{i}' for i in range(20)],
            'artifacts':[{'path':f'src/f-{i:03d}.py','sha256':'a'*64} for i in range(20)]}
    db.conn.execute("UPDATE tasks SET status='done',result=? WHERE id='a'",(json.dumps(result),))
    return result


@pytest.mark.parametrize('section',['artifacts','evidence','uncertainties','summary'])
def test_result_pages_recover_all_records_not_only_card_excerpt(db,section):
    result=stored_result(db)
    board=Coordination(db,Config(context_items=3))
    items=[];cursor='';seen=set()
    while True:
        page=board.result_page('b','a',section=section,after=cursor)
        assert len(page['items'])<=3
        items.extend(page['items'])
        cursor=page['next_after']
        if cursor is None:break
        assert cursor not in seen;seen.add(cursor)
    expected={'artifacts':result['artifacts'],
              'evidence':[{'evidence_id':i,'record_status':'MISSING','verdict':'UNKNOWN'} for i in result['gate_evidence']],
              'uncertainties':[{'uncertainty_unverified':i} for i in result['uncertainties']],
              'summary':[{'summary_unverified':result['model_summary']}]}[section]
    assert items==expected
    assert board.card('a')['uncertainties_total']==20
    assert len(board.card('a')['uncertainties_unverified'])==2


@pytest.mark.parametrize('section,cursor',[('bad',''),('evidence','-1'),('evidence','abc'),('summary','999999999'),('uncertainties','\u0661')])
def test_invalid_result_sections_and_cursors_fail(db,section,cursor):
    stored_result(db)
    with pytest.raises(ContractError):
        Coordination(db,Config()).result_page('b','a',section=section,after=cursor)


def test_large_observation_is_really_retained_and_hash_matches(tmp_path,db,config):
    db.add_tasks([TaskSpec('a','A','A')]);claim=db.claim('w')
    worker=Worker(tmp_path,claim,config,db,ScriptBackend(),asyncio.Lock())
    worker.workspace.prepare()
    original={'large_result':'z'*20000}
    worker.observe('read',original)
    item=worker.history[-1]['result']
    assert item['truncated'] is True
    data=(tmp_path/item['full_evidence']).read_bytes()
    assert hashlib.sha256(data).hexdigest()==item['sha256']
    assert json.loads(data)==original
    worker.observe('small',{'value':1})
    assert len(list(worker.workspace.artifacts.glob('observation-*.json')))==2


async def test_http_byte_ceiling_rejects_before_request_and_reservation(config,db):
    calls=[]
    client=httpx.AsyncClient(transport=httpx.MockTransport(lambda request:calls.append(request)))
    config.max_context_bytes=4096
    backend=HTTPBackend(config,db,client=client)
    try:
        with pytest.raises(ContractError):
            await backend.complete([{'role':'user','content':'\U0001f9e0'*1500}],'a')
    finally:
        await client.aclose()
    assert not calls
    assert not db.rows('SELECT * FROM reservations')


async def test_command_byte_ceiling_rejects_before_subprocess(config,db,tmp_path):
    config.backend='command';config.command_argv=[sys.executable,'-c','raise SystemExit(17)']
    config.max_context_bytes=4096
    backend=CommandBackend(config,db)
    with pytest.raises(ContractError):
        await backend.complete([{'role':'user','content':'\U0001f9e0'*1500}],'a',tmp_path)
    assert not db.rows('SELECT * FROM reservations')


def test_atomic_admission_cannot_exceed_children_across_multiple_batches(db):
    db.add_tasks([TaskSpec('p','P','P')])
    db.add_tasks([TaskSpec('c','C','C',parent_id='p',depth=1)],max_children=1,max_depth=2)
    with pytest.raises(ContractError):
        db.add_tasks([TaskSpec('d','D','D',parent_id='p',depth=1)],max_children=1,max_depth=2)
    assert [r['id'] for r in db.tasks()]==['p','c']


@pytest.mark.parametrize('child_depth,max_depth',[(0,2),(2,2),(1,0)])
def test_prebuilt_graph_depth_is_validated_at_admission(db,child_depth,max_depth):
    with pytest.raises(ContractError):
        db.add_tasks([TaskSpec('p','P','P'),TaskSpec('c','C','C',parent_id='p',depth=child_depth)],
                     max_children=8,max_depth=max_depth)
    assert not db.tasks()


async def test_daemon_rejects_manually_oversized_cells_before_model_call(tmp_path,config):
    from conftest import queue
    from future_code.runtime import Supervisor
    config.max_children=1
    queue(tmp_path,[TaskSpec('p','P','P'),TaskSpec('c','C','C',parent_id='p',depth=1),
                    TaskSpec('d','D','D',parent_id='p',depth=1)])
    backend=ScriptBackend()
    with pytest.raises(ContractError):
        await Supervisor(tmp_path,config,backend=backend).run(until_idle=True)
    assert not backend.requests


def test_selective_descendant_reads_do_not_grant_broadcast_or_cross_tree_read(db):
    from future_code.coordination import build_hierarchy
    tasks=build_hierarchy([TaskSpec(f'L{i}','L','L') for i in range(16)],root_id='root',fanout=4)
    db.add_tasks(tasks+[TaskSpec('unrelated','U','U')])
    board=Coordination(db,Config(context_items=2))
    group=board.inspect('root',relation='children')['items'][0]['id']
    page=board.inspect('root',relation='children',target=group)
    leaf=page['items'][0]['id']
    assert board.readable('root',leaf)
    assert not board.allowed('root',leaf) # no direct messaging/broadcast privilege
    assert board.result_page('root',leaf)['card']['id']==leaf
    assert board.card('root')['subtree_counts']['leaves']==16
    with pytest.raises(ContractError):board.inspect(leaf,relation='children',target='root')
    with pytest.raises(ContractError):board.result_page('root','unrelated')


def test_recorded_gate_details_are_bounded_and_missing_evidence_is_unknown(db):
    result=stored_result(db)
    eid=db.add_evidence('a','attempt','unit','PASS','f'*64,'logs/test.json',{'output':'x'*3000})
    result['gate_evidence']=[eid,'missing']
    db.conn.execute("UPDATE tasks SET result=? WHERE id='a'",(json.dumps(result),))
    board=Coordination(db,Config())
    page=board.result_page('b','a',section='evidence')
    actual,missing=page['items']
    assert actual['verdict']=='PASS' and actual['details_truncated']
    assert len(actual['details_excerpt_untrusted'].encode())<=1600
    assert missing['verdict']=='UNKNOWN' and missing['record_status']=='MISSING'


@pytest.mark.parametrize('fields',[{'task_id':[]},{'task_id':None},{'task_id':'a','section':[]},
                                   {'task_id':'a','section':None}])
def test_model_result_arguments_fail_as_contract_errors_not_worker_crashes(db,fields):
    stored_result(db)
    with pytest.raises(ContractError):
        Coordination(db,Config()).result_page('b',**fields)


async def test_finish_cannot_skip_an_undelivered_mailbox_page(tmp_path,config):
    from conftest import queue
    from future_code.runtime import Supervisor
    from future_code.store import Store
    config.context_items=1
    queue(tmp_path,[TaskSpec('a','A','A'),TaskSpec('b','B','B',dependencies=['a'])])
    with Store(tmp_path/'.future-code/state.db') as database:
        a=database.claim('w')
        database.send_message('a',a['fence'],'b','Interface constraint one')
        database.send_message('a',a['fence'],'b','Interface constraint two')
        database.finish('a',a['fence'],'done')
    backend=ScriptBackend()
    result=await Supervisor(tmp_path,config,backend=backend).run(until_idle=True)
    assert set(result['task_states'].values())=={'done'}
    with Store(tmp_path/'.future-code/state.db') as database:
        assert not database.messages('b',database.memory('b')['delivered_seq'])
    assert len(backend.requests)==2
