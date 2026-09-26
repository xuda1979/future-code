"""Real-source replay and NEW checker executions; provenance is explicit.

Archived v2 outcomes are reused for layout training/validation/replay, not
relabeled as newly executed tests. The --run mode records fresh subprocesses.
"""
from __future__ import annotations
import argparse,json,hashlib,time,tempfile,shutil
from pathlib import Path
import numpy as np
from ichact.impact import ImpactModel,Intervention
from ichact.frontier import completion_waves
from ichact.layout import Layout,fit_catalogue,fit_layout,select_validation
from ichact.cli import operate
from hact.tree import compact_balanced
from hact.certificates import digest
from experiments.benchmarks import SCOPES
ROOT=Path(__file__).resolve().parents[1];HIST=ROOT/'historical/results_v2';OUT=ROOT/'results/v3'


def load(project):
    prefix='future_core' if project=='future' else project
    base=json.loads((HIST/'baselines'/f'{prefix}_plain.json').read_text())
    profile=json.loads((HIST/'baselines'/f'{prefix}_profile.json').read_text())
    all_records=[json.loads(p.read_text()) for p in sorted((HIST/'mutations').glob(f'{project}_*.json'))]
    valid=[r for r in all_records if not r['timed_out'] and not r['collection_errors'] and r['returncode'] in (0,1) and r['registry']==base['registry'] and set(r['records'])==set(base['registry']) and all(v['status'] in ('PASS','FAIL') for v in r['records'].values())]
    train=[r for r in valid if r['mutation']['split']=='train']
    costs={g:sum(v['seconds'] for v in rec['phases'].values()) for g,rec in base['records'].items()}
    calls={g:rec['dependencies'] for g,rec in profile['records'].items()}
    model=ImpactModel(base['registry'],costs,calls,[Intervention(r['mutation']['source'],frozenset(g for g,v in r['records'].items() if v['status']=='FAIL'),r['mutation']['id']) for r in train])
    return base,all_records,valid,model


def replay():
    out=[];new_plan=[]
    for project in SCOPES:
        base,allr,valid,model=load(project);registry=tuple(base['registry']);indices={g:i for i,g in enumerate(registry)};n=len(registry)
        def waves(r):
            order=model.order(r['mutation']['source'],'conditional')
            failed={indices[g] for g,v in r['records'].items() if v['status']=='FAIL'}
            return completion_waves([indices[g] for g in order],failed,8)
        train=[waves(r) for r in valid if r['mutation']['split']=='train']
        validation=[waves(r) for r in valid if r['mutation']['split']=='test']
        test=[r for r in valid if r['mutation']['split']=='confirmation']
        start=time.perf_counter();cat=fit_catalogue(registry,train);fittime=time.perf_counter()-start
        chosen,scores=select_validation(cat,validation)
        random_order=tuple(map(int,np.random.default_rng(20260920).permutation(n)))
        shuffled=fit_layout(registry,train,random_order)
        cat['shuffled']=shuffled;cat['fixed8']=Layout(registry,tuple(range(n)),compact_balanced(n,8))
        directory=OUT/'real_replay'/project;directory.mkdir(parents=True,exist_ok=True)
        for name,l in cat.items():(directory/f'layout-{name}.json').write_text(json.dumps(l.to_dict(),indent=2))
        records=[]
        for r in test:
            ep=waves(r);costs={name:l.cost(ep) for name,l in cat.items()};costs['selected']=costs[chosen]
            records.append({'id':r['mutation']['id'],'source':r['mutation']['source'],'oracle':r['returncode'],'waves':ep,'costs':costs})
        summary={'project':project,'n':n,'archived_cases':len(allr),'valid_cases':len(valid),'training':len(train),'validation':len(validation),'confirmation_replay':len(test),'selected':chosen,'validation_costs':scores,'fitting_seconds':fittime,'records':records}
        out.append(summary)
        # Fixed deterministic ID criterion, independent of outcome or improvement.
        new_plan.extend({'project':project,'id':r['mutation']['id'],'selected_layout':chosen} for r in test[:4])
        print('replay',project,n,'selected',chosen,'cases',len(test),flush=True)
    (OUT/'real_replay_summary.json').write_text(json.dumps(out,indent=2))
    (ROOT/'docs/V3_FRESH_CHECKER_PLAN.json').write_text(json.dumps({'criterion':'first four lexically sorted confirmation IDs per project; paired fixed8 vs validation-selected layout, with the SAME execution order','cases':new_plan},indent=2))


def execute_new():
    plan=json.loads((ROOT/'docs/V3_FRESH_CHECKER_PLAN.json').read_text());reports=[]
    for project,scope in SCOPES.items():
        base,allr,valid,model=load(project);lookup={r['mutation']['id']:r for r in valid}
        selected=[p for p in plan['cases'] if p['project']==project]
        out=OUT/'fresh_checkers'/project;out.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='adaptive-hact-real-') as tmp:
            source=Path(tmp)/'candidate';shutil.copytree(ROOT/'vendor'/project,source,ignore=shutil.ignore_patterns('__pycache__','*.pyc','.pytest_cache','.future-code','.ai-loop'))
            contract=out/'approved-contract.json'
            baseline=operate(source,contract,out/'baseline',initialize=True,test_paths=scope['tests'],pythonpath=[scope['pythonpath']],timeout=60)
            assert baseline['verdict']=='PASS'
            for position,p in enumerate(selected):
                old=lookup[p['id']];mut=old['mutation'];file=source/mut['source'];original=file.read_text()
                assert hashlib.sha256(file.read_bytes()).hexdigest()==mut['base_sha256']
                # Prior record gives the exact transformed source; inspect schema.
                lines=original.splitlines(keepends=True)
                if 'mutant_text' in mut:changed=mut['mutant_text']
                else:
                    # Mutation plans contain full source edits as line/column spans.
                    changed=apply_mutation(original,mut)
                assert hashlib.sha256(changed.encode()).hexdigest()==mut['mutant_sha256']
                file.write_text(changed)
                ordered=model.order(mut['source'],'conditional')
                methods=['fixed8',p['selected_layout']]
                if position%2:methods.reverse()
                for method in methods:
                    layout=Layout.from_dict(json.loads((OUT/'real_replay'/project/f'layout-{method}.json').read_text()))
                    wall=time.perf_counter();report=operate(source,contract,out/f"{p['id']}-{method}",layout=layout,order=ordered,timeout=60);elapsed=time.perf_counter()-wall
                    expected='PASS' if old['returncode']==0 else 'FAIL'
                    assert report['verdict']==expected,(project,p['id'],report['verdict'],expected)
                    assert report['packet_bytes']==(out/f"{p['id']}-{method}"/'certificate_packets.bin').stat().st_size
                    reports.append({'project':project,'id':p['id'],'method':method,'expected':expected,'observed_wall_seconds':elapsed,'report':report})
                file.write_text(original)
            # A final fresh full-pass reference shows restoration, not autonomous repair.
            restored=operate(source,contract,out/'restored',timeout=60)
            assert restored['verdict']=='PASS'
        print('fresh checker runs',project,'complete',flush=True)
    (OUT/'fresh_checker_summary.json').write_text(json.dumps(reports,indent=2))


def apply_mutation(text,mut):
    # Same archived span transformation, without calling the archived mutator.
    if 'span' in mut:
        left,right=mut['span'];return text[:left]+mut['replacement']+text[right:]
    if 'start' in mut and 'end' in mut:
        return text[:mut['start']]+mut['replacement']+text[mut['end']:]
    if 'line' in mut:
        lines=text.splitlines(keepends=True);line=mut['line']-1
        if 'before' in mut and 'after' in mut:
            if mut['before'] not in lines[line]:raise ValueError('mutation source mismatch')
            lines[line]=lines[line].replace(mut['before'],mut['after'],1);return ''.join(lines)
    raise ValueError('unsupported archived mutation fields '+str(sorted(mut)))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('mode',choices=['replay','run']);args=p.parse_args()
    replay() if args.mode=='replay' else execute_new()
