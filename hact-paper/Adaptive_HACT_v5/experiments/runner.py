from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import subprocess
import signal
import sys
import time
from experiments.benchmarks import SCOPES
ROOT = Path(__file__).resolve().parents[1]

def execute(project, snapshot, output, *, order=None, failfast=False, profile=False, timeout=60):
    scope=SCOPES[project]; snapshot=Path(snapshot).resolve(); output=Path(output).resolve()
    output.parent.mkdir(parents=True,exist_ok=True)
    env=dict(os.environ,PYTHONPATH=os.pathsep.join([str(snapshot/scope['pythonpath']),str(ROOT)]),
             PYTHONDONTWRITEBYTECODE='1',PYTEST_DISABLE_PLUGIN_AUTOLOAD='1',PYTHONHASHSEED='0',
             IC_SOURCE_ROOT=str(snapshot),IC_REPORT=str(output),IC_PROFILE='1' if profile else '0')
    env.pop('IC_ORDER',None)
    if order is not None:
        op=output.with_suffix('.order.json'); op.write_text(json.dumps(order)); env['IC_ORDER']=str(op)
    cmd=[sys.executable,'-B','-m','pytest','-q','-p','ichact.pytest_probe','-p','pytest_asyncio.plugin','--tb=short']
    if failfast: cmd+=['-x']
    cmd+=scope['tests']; start=time.perf_counter(); timed_out=False
    logfile=output.with_suffix('.log')
    with logfile.open('w') as log:
        proc=subprocess.Popen(cmd,cwd=snapshot,env=env,stdout=log,stderr=subprocess.STDOUT,
                              text=True,start_new_session=True)
        try:
            code=proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out=True; code=-1
            os.killpg(proc.pid,signal.SIGKILL)
            proc.wait(timeout=5)
            log.write('\nTIMEOUT; no completed verdict\n')
    duration=time.perf_counter()-start
    r=json.loads(output.read_text()) if output.exists() else {'registry':[],'executed':[],'records':{},'collection_errors':[],'exitstatus':code}
    r.update({'end_to_end_seconds':duration,'timed_out':timed_out,'command':cmd,'project':project,
              'returncode':code,'failfast':failfast,'snapshot':str(snapshot)})
    output.write_text(json.dumps(r,sort_keys=True,indent=2)); return r

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--baseline',action='store_true'); args=ap.parse_args()
    if args.baseline:
        for project in SCOPES:
            for profile in (False,True):
                label='profile' if profile else 'plain'; out=ROOT/'results/baselines'/f'{project}_{label}.json'
                r=execute(project,ROOT/'vendor'/project,out,profile=profile)
                counts={s:sum(x.get('status')==s for x in r['records'].values()) for s in ['PASS','FAIL','UNKNOWN']}
                print(project,label,len(r['registry']),counts,round(r['end_to_end_seconds'],3),flush=True)
                if r['exitstatus']!=0 or counts['FAIL'] or counts['UNKNOWN']: raise RuntimeError(f'baseline not clean: {out}')
if __name__=='__main__': main()
