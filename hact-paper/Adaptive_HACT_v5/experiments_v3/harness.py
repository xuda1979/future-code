"""Actual Future Code runtime + actual SQLite/HTTP tests; SCRIPTED model actions.

No hosted model is invoked. Run --repetitions 3 for the fixed paired experiment.
Contracts, layout training and runtime initialization are measured separately
from active daemon episodes. Local HTTP request bytes are NOT token counts.
"""
from __future__ import annotations
import argparse,asyncio,json,os,shutil,sys,threading,time
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'vendor/future/src'))
from future_code.contracts import Config,Endpoint,GateSpec,TaskSpec
from future_code.runtime import Supervisor
from future_code.security import atomic_write,ensure_control
from future_code.store import Store
import future_code.worker as worker_module
from ichact.cli import operate
from ichact.layout import fit_catalogue,select_validation

FINISH={'action':'finish','summary':'Submit the candidate to protected executable checks','uncertainties':['Actions are scripted; no hosted LLM inference is measured']}
FIXTURE=ROOT/'experiments_v3/io_fixture'
OUT=ROOT/'results/v3/harness'


def scripts():
    children=[{'id':x,'title':f'Repair {x}','instructions':f'Repair only {x}.py, preserve tests, verify actual I/O',
               'write_scope':[x+'.py'],'gates':[x]} for x in ('ledger','transport')]
    result={'project':[{'action':'delegate','tasks':children},FINISH]}
    for name in ('ledger','transport'):
        correct=(FIXTURE/(name+'.py')).read_text()
        wrong='def apply(*args, **kwargs):\n    return 0\n' if name=='ledger' else 'def fetch_json(*args, **kwargs):\n    return {}\n'
        result[name]=[{'action':'read','path':name+'.py'},
            {'action':'write','path':name+'.py','content':wrong},FINISH,
            {'action':'write','path':name+'.py','content':correct},FINISH]
    return result


class Server(ThreadingHTTPServer):
    daemon_threads=True
    def __init__(self):
        super().__init__(('127.0.0.1',0),Handler)
        self.lock=threading.Lock();self.scripts=scripts();self.indices={};self.records=[];self.failures=0


class Handler(BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    def log_message(self,*args):pass
    def reply(self,status,payload):
        body=json.dumps(payload).encode();self.send_response(status)
        self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)))
        if status==503:self.send_header('Retry-After','.02')
        self.end_headers();self.wfile.write(body)
        return len(body)
    def do_POST(self):
        size=int(self.headers.get('Content-Length','0'))
        if not 0<size<1_000_000:self.reply(400,{'error':'bad size'});return
        payload=json.loads(self.rfile.read(size));packet=json.loads(payload['messages'][1]['content']);task=packet['task']['id']
        with self.server.lock:
            record={'task':task,'body_bytes':size,'message_utf8_bytes':sum(len(m['content'].encode()) for m in payload['messages'])}
            self.server.records.append(record)
            if len(self.server.records)==1:
                self.server.failures+=1;record['status']=503;record['response_bytes']=self.reply(503,{'error':'injected transient outage'});return
            index=self.server.indices.get(task,0);self.server.indices[task]=index+1
            seq=self.server.scripts[task];action=seq[min(index,len(seq)-1)]
        time.sleep(.01)
        record['status']=200;record['response_bytes']=self.reply(200,{'choices':[{'message':{'content':json.dumps(action)}}]})


def prepare():
    OUT.mkdir(parents=True,exist_ok=True);trusted=OUT/'trusted'
    if trusted.exists():raise ValueError('output already exists; retain it and choose a fresh output root')
    trusted.mkdir();baseline=trusted/'baseline';shutil.copytree(FIXTURE,baseline,ignore=shutil.ignore_patterns('__pycache__','.pytest_cache','*.pyc'))
    rows={}
    for name,paths in [('ledger',['tests/test_ledger.py']),('transport',['tests/test_transport.py']),('integration',['tests'])]:
        start=time.perf_counter();contract=trusted/(name+'.contract.json')
        report=operate(baseline,contract,trusted/(name+'-baseline'),initialize=True,test_paths=paths)
        registry=tuple(json.loads(contract.read_text())['registry']);n=len(registry)
        # Explicit predeployment completion-wave calibration, not evaluation outcomes.
        rng=np.random.default_rng(4121+n);groups=[list(range(i,min(i+4,n))) for i in range(0,n,4)]
        episodes=[[groups[int(rng.integers(len(groups)))]] for _ in range(192)]
        fit_start=time.perf_counter();cat=fit_catalogue(registry,episodes[:128]);selected,score=select_validation(cat,episodes[128:]);layout=cat[selected]
        layout_path=trusted/(name+'.layout.json');layout_path.write_text(json.dumps(layout.to_dict(),indent=2))
        rows[name]={'contract':str(contract),'layout':str(layout_path),'selected':selected,'required':n,
                    'preparation_seconds':time.perf_counter()-start,'fit_seconds':time.perf_counter()-fit_start,
                    'calibration':episodes,'validation_costs':score,'baseline':report}
    (trusted/'preparation.json').write_text(json.dumps(rows,indent=2));return rows


def initialize(project,mode,server,prepared,reports):
    shutil.copytree(FIXTURE,project,ignore=shutil.ignore_patterns('__pycache__','.pytest_cache','*.pyc'))
    for name in ('ledger','transport'):(project/(name+'.py')).write_text('# Candidate starts with an intentionally broken implementation.\n')
    gates={}
    for name in ('ledger','transport','integration'):
        if mode=='direct':
            paths=['tests'] if name=='integration' else ['tests/test_'+name+'.py']
            argv=['$PYTHON','-B','-m','pytest','-q','-p','no:cacheprovider','-x',*paths]
        else:
            argv=['$PYTHON','-B',str(ROOT/'ichact/future_bridge.py'),'--contract',prepared[name]['contract'],'--reports',str(reports/name),'--timeout','60']
            if mode=='learned':argv+=['--layout',prepared[name]['layout']]
        gates[name]=GateSpec(argv,timeout_seconds=90,protected_inputs=['tests'])
    config=Config(endpoint=Endpoint(url=f'http://127.0.0.1:{server.server_port}/v1/chat/completions',model='LOCAL_SCRIPTED_IO_FIXTURE_NOT_LLM'),
                  max_workers=2,heartbeat_seconds=.1,lease_seconds=30,stale_seconds=30,poll_seconds=.02,
                  retry_base_seconds=.02,retry_cap_seconds=.1,minimum_free_bytes=0,
                  max_requests=60,max_reserved_tokens=600000,gates=gates,protected_paths=['tests'])
    control=ensure_control(project);atomic_write(control/'config.json',json.dumps(config.to_dict(),indent=2).encode())
    task=TaskSpec('project','Repair and integrate persistent I/O components','Delegate ledger and transport work, then verify the integrated system',
                  write_scope=['ledger.py','transport.py'],gates=['integration'],role='coordinator',timeout_seconds=180)
    config.validate_task(task)
    with Store(control/'state.db') as db:db.add_tasks([task])
    return config


async def execute(project,config):
    sup=Supervisor(project,config);job=asyncio.create_task(sup.run())
    try:
        async with asyncio.timeout(180):
            while not job.done():
                await asyncio.sleep(.05);rows=sup.db.tasks()
                if rows and all(r['status']=='done' for r in rows):sup.stop();break
                if any(r['status'] in {'blocked','failed'} for r in rows):
                    raise RuntimeError(f'Fixture blocked: {[(r["id"],r["status"]) for r in rows]}')
            result=await job
            if any(v!='done' for v in result['task_states'].values()):raise RuntimeError('incomplete task graph')
            return result
    finally:
        sup.stop();await asyncio.gather(job,return_exceptions=True)


def episode(index,mode,prepared):
    directory=OUT/f'{index:02d}-{mode}';directory.mkdir();server=Server()
    thread=threading.Thread(target=server.serve_forever,kwargs={'poll_interval':.02},daemon=True);thread.start()
    project=directory/'project';start=time.perf_counter();config=initialize(project,mode,server,prepared,directory/'gate-reports');initsec=time.perf_counter()-start
    builds=[];original=worker_module.build_context
    def timed_context(*args,**kwargs):
        t=time.perf_counter();value=original(*args,**kwargs);builds.append(time.perf_counter()-t);return value
    worker_module.build_context=timed_context
    try:
        start=time.perf_counter();result=asyncio.run(execute(project,config));wall=time.perf_counter()-start
        with Store(project/'.future-code/state.db',readonly=True) as db:
            gates=db.rows('SELECT task_id,kind,verdict,fingerprint FROM evidence ORDER BY created_at')
            usage=db.rows('SELECT actual_tokens FROM reservations')
        reports=[json.loads(p.read_text()) for p in sorted((directory/'gate-reports').glob('*/*/report.json'))]
        assert all((project/(n+'.py')).read_text()==(FIXTURE/(n+'.py')).read_text() for n in ('ledger','transport'))
        assert sum(r['verdict']=='FAIL' for r in gates)>=2
        record={'repetition':index,'method':mode,'scope':'Scripted local HTTP model actions; actual harness, subprocess gates, filesystem, SQLite and HTTP I/O tests',
                'initialization_seconds':initsec,'active_episode_seconds':wall,**result,
                'context_construction_seconds':sum(builds),'context_build_count':len(builds),
                'http_requests':server.records,'http_503':server.failures,'gate_history':gates,
                'gate_reports':reports,'hosted_llm_tokens':None,'provider_usage_rows':usage,
                'packet_bytes':sum(r['packet_bytes'] for r in reports) if mode!='direct' else None,
                'largest_packet_bytes':max((r['largest_packet_bytes'] for r in reports),default=0) if mode!='direct' else None,
                'total_prompt_message_bytes':sum(r['message_utf8_bytes'] for r in server.records),
                'largest_prompt_message_bytes':max(r['message_utf8_bytes'] for r in server.records)}
        (directory/'record.json').write_text(json.dumps(record,indent=2));return record
    finally:
        worker_module.build_context=original;server.shutdown();server.server_close();thread.join(timeout=2)


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--repetitions',type=int,default=3);a=p.parse_args()
    prepared=prepare();rows=[]
    (ROOT/'docs/V3_HARNESS_PLAN.json').write_text(json.dumps({'repetitions':a.repetitions,'modes':['direct','fixed8','learned'],
        'actions':'scripted fixed read/wrong write/reject/correct write/accept; two child scopes and one integration task',
        'ordering':'Latin rotation by repetition','credentials':'none','token_measurement':'UNKNOWN'},indent=2))
    for i in range(a.repetitions):
        methods=['direct','fixed8','learned'];methods=methods[i%3:]+methods[:i%3]
        for mode in methods:
            row=episode(i,mode,prepared);rows.append(row)
            print('harness',i,mode,'seconds',row['active_episode_seconds'],'bytes',row['packet_bytes'],flush=True)
            (ROOT/'results/v3/harness_summary.json').write_text(json.dumps(rows,indent=2))
if __name__=='__main__':main()
