"""A usable local strict pytest verification gate.

The approved contract must be created on a trusted baseline and kept outside
candidate write scopes. Private copying is isolation of files, not an OS sandbox.
"""
from __future__ import annotations
import argparse
import json
import math
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from .identity import source_manifest, canonical, checker_identity, environment_identity
from .guard import EpochGuard
from .adaptive_guard import AdaptiveGuard
from .layout import Layout
from hact.tree import compact_balanced, Node, validate_tree, CostModel


def protected(name: str) -> bool:
    p=Path(name)
    return (p.name in {'pyproject.toml','pytest.ini','setup.cfg','conftest.py'} or
            'tests' in p.parts or p.name.startswith('test_') or p.name.endswith('_test.py'))

def _inside(path: Path, parent: Path) -> bool:
    return path.resolve().is_relative_to(parent.resolve())

def _run(snapshot:Path, evidence:Path, test_paths:list[str], pythonpath:list[str],
         timeout:float, order, failfast:bool):
    env=os.environ.copy()
    base=Path(__file__).resolve().parents[1]
    env.update(PYTHONPATH=os.pathsep.join([str(snapshot/p) for p in pythonpath]+[str(base)]),
        PYTHONDONTWRITEBYTECODE='1',PYTEST_DISABLE_PLUGIN_AUTOLOAD='1',PYTHONHASHSEED='0',
        IC_SOURCE_ROOT=str(snapshot),IC_REPORT=str(evidence),IC_PROFILE='0')
    env.pop('IC_ORDER',None)
    if order is not None:
        ordered=evidence.with_suffix('.order.json');ordered.write_text(json.dumps(order));env['IC_ORDER']=str(ordered)
    command=[sys.executable,'-B','-m','pytest','-q','-p','ichact.pytest_probe','-p','pytest_asyncio.plugin','--tb=short']
    if failfast:command.append('-x')
    command.extend(test_paths)
    start=time.perf_counter();timeout_hit=False
    with evidence.with_suffix('.log').open('w') as output:
        proc=subprocess.Popen(command,cwd=snapshot,env=env,stdout=output,stderr=subprocess.STDOUT,start_new_session=True)
        try:code=proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timeout_hit=True;os.killpg(proc.pid,signal.SIGKILL);proc.wait();code=-1
    raw=json.loads(evidence.read_text()) if evidence.exists() else {}
    return raw,code,timeout_hit,time.perf_counter()-start


def operate(project:Path,contract_path:Path,output:Path,*,initialize:bool=False,
            test_paths=None,pythonpath=None,timeout:float=60,order=None,tree=None,layout:Layout|None=None):
    project=project.resolve();output=output.resolve();contract_path=contract_path.resolve()
    if _inside(output,project) or _inside(contract_path,project):
        raise ValueError('keep reports and trusted contracts outside candidate write scope')
    if not math.isfinite(timeout) or timeout<=0:raise ValueError('finite positive timeout required')
    if tree is not None and layout is not None:raise ValueError('choose tree or named layout, not both')
    if initialize and contract_path.exists():raise ValueError('refusing to overwrite approved contract')
    start=time.perf_counter()
    initial=source_manifest(project)
    if initialize:
        test_paths=test_paths or ['tests'];pythonpath=pythonpath or ['.']
    else:
        approved=json.loads(contract_path.read_text())
        test_paths=approved['test_paths'];pythonpath=approved['pythonpath']
        if {k:v for k,v in initial.items() if protected(k)}!=approved['protected_files']:
            raise ValueError('protected acceptance inputs added, removed, or changed')
        if approved.get('schema')!=2:raise ValueError('reinitialize legacy contract on a reviewed trusted baseline')
    for value in test_paths+pythonpath:
        # Pytest node suffixes are not needed in this minimal wrapper.
        if not isinstance(value,str) or value.startswith('-') or not _inside(project/value,project):
            raise ValueError('test and import paths must stay in candidate snapshot')
    output.mkdir(parents=True,exist_ok=False)
    environment=environment_identity();checker=checker_identity()
    if not initialize and (canonical(environment)!=approved['baseline_environment'] or checker!=approved['baseline_checker']):
        raise ValueError('approved checker or environment changed; review and reinitialize contract')
    preparation_seconds=time.perf_counter()-start
    snapshot_started=time.perf_counter()
    with tempfile.TemporaryDirectory(prefix='ichact-verify-') as work:
        snapshot=Path(work)/'candidate'
        shutil.copytree(project,snapshot,ignore=shutil.ignore_patterns('__pycache__','*.pyc','.pytest_cache','.git','.future-code','.ai-loop'))
        before=source_manifest(snapshot)
        if before!=initial:raise ValueError('source changed during snapshot acquisition')
        snapshot_copy_seconds=time.perf_counter()-snapshot_started
        raw,code,timedout,seconds=_run(snapshot,output/'pytest_evidence.json',test_paths,pythonpath,timeout,order,not initialize)
        after=source_manifest(snapshot)
    # No actual repository merge is performed by this wrapper.
    final_source_unchanged=source_manifest(project)==initial
    registry=raw.get('registry',[]) if initialize else approved['registry']
    trustworthy=(bool(registry) and before==after and final_source_unchanged and
                 raw.get('registry')==registry and not raw.get('collection_errors') and
                 not timedout and code in (0,1))
    if not registry:registry=['__missing_collection__']
    aggregation_start=time.perf_counter()
    tree_shape=layout.tree if layout is not None else tree or compact_balanced(len(registry),8)
    validate_tree(tree_shape,len(registry),CostModel())
    if layout is not None:
        if layout.registry!=tuple(registry):raise ValueError('layout does not match approved semantic registry')
        gate=AdaptiveGuard(registry,canonical(before),checker,canonical(environment),layout)
        refresh=gate.refresh
    else:
        gate=EpochGuard(registry,canonical(before),checker,canonical(environment))
        refresh=lambda:gate.refresh(tree_shape)
    _,packets=refresh();all_packets=list(packets)
    if trustworthy:
        index={name:i for i,name in enumerate(registry)};executed=raw.get('executed',[])
        for offset in range(0,len(executed),8):
            for name in executed[offset:offset+8]:
                rec=raw.get('records',{}).get(name)
                if rec is not None:gate.submit(gate.token(name if layout is not None else index[name]),rec.get('status','UNKNOWN'),canonical(rec))
            _,packets=refresh();all_packets.extend(packets)
    root,_=refresh()
    verdict=root.verdict if trustworthy else 'UNKNOWN'
    if verdict=='PASS' and not (code==0 and len(raw.get('records',{}))==len(registry)):
        verdict='UNKNOWN'
    ticket=gate.issue() if verdict=='PASS' else None
    if initialize:
        if verdict!='PASS':raise ValueError('baseline contract requires complete PASS; see evidence')
        approved={'schema':2,'registry':registry,'test_paths':test_paths,'pythonpath':pythonpath,
                  'protected_files':{k:v for k,v in initial.items() if protected(k)},
                  'baseline_snapshot':canonical(initial),'baseline_environment':canonical(environment),'baseline_checker':checker,
                  'warning':'Trust this contract only after reviewing acceptance adequacy and keeping it outside agent write scopes.'}
        contract_path.parent.mkdir(parents=True,exist_ok=True);contract_path.write_text(json.dumps(approved,indent=2))
    aggregation_seconds=time.perf_counter()-aggregation_start
    record={'schema':2,'verdict':verdict,'required':len(registry),'executed':len(raw.get('executed',[])),
        'counts':list(root.counts),'snapshot':canonical(before),'checker':checker,'environment':canonical(environment),
        'registry_hash':canonical(registry),'tree':tree_shape.to_dict(),
        'layout_id':layout.uid if layout is not None else None,'layout_order':list(layout.order) if layout is not None else list(range(len(registry))),'packet_bytes':sum(map(len,all_packets)),
        'largest_packet_bytes':max(map(len,all_packets),default=0),'packet_count':len(all_packets),
        'pytest_process_seconds':seconds,'complete_wrapper_seconds':time.perf_counter()-start,
        'preparation_seconds':preparation_seconds,'snapshot_copy_seconds':snapshot_copy_seconds,
        'aggregation_seconds':aggregation_seconds,'hosted_llm_tokens':None,
        'timing_boundary':'Complete wrapper duration is measured before final report/packet file writes; checker subprocess includes startup and collection.',
        'timed_out':timedout,'process_code':code,'snapshot_unchanged':before==after,
        'source_unchanged':final_source_unchanged,'locally_authorized':bool(ticket and gate.authorize(ticket)),
        'boundary':'Local evidence authorization only; not an atomic repository merge, sandbox, remote attestation, or proof of arbitrary program correctness.'}
    (output/'source_manifest.json').write_text(json.dumps(before,sort_keys=True,indent=2))
    (output/'environment.json').write_text(json.dumps(environment,sort_keys=True,indent=2))
    (output/'report.json').write_text(json.dumps(record,indent=2))
    with (output/'certificate_packets.bin').open('wb') as out:
        for packet in all_packets:out.write(packet)
    return record


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('command',choices=['init','verify'])
    p.add_argument('--project',type=Path,required=True);p.add_argument('--contract',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True);p.add_argument('--test-path',action='append')
    p.add_argument('--pythonpath',action='append');p.add_argument('--timeout',type=float,default=60)
    p.add_argument('--order',type=Path,help='JSON exact registry permutation; never a subset')
    p.add_argument('--layout',type=Path,help='JSON stable-ID layout; independent of test execution order')
    a=p.parse_args()
    r=operate(a.project,a.contract,a.output,initialize=a.command=='init',test_paths=a.test_path,
              pythonpath=a.pythonpath,timeout=a.timeout,order=json.loads(a.order.read_text()) if a.order else None,
              layout=Layout.from_dict(json.loads(a.layout.read_text())) if a.layout else None)
    print(json.dumps({k:r[k] for k in ['verdict','required','executed','packet_bytes','largest_packet_bytes','complete_wrapper_seconds']},indent=2))
    raise SystemExit(0 if r['verdict']=='PASS' else 1 if r['verdict']=='FAIL' else 2)
if __name__=='__main__':main()
