"""Frozen first-four-ID confirmation timing; no outcome-dependent replacement."""
from __future__ import annotations
import json,random,time
from experiments.runner import ROOT
from experiments.analyze import load
from experiments.mutations import run_one
from experiments.benchmarks import SCOPES

def main():
    contract=json.loads((ROOT/'docs/CONFIRMATION_PLAN.json').read_text());models={};cases=[];cohort=[]
    for project in SCOPES:
        base,reports,valid,training,model=load(project);models[project]=model
        chosen=sorted([r for r in contract['rows'] if r['project']==project],key=lambda x:x['id'])[:4]
        complete={r['mutation']['id']:r for r in valid if r['mutation']['split']=='confirmation'}
        for row in chosen:
            eligible=row['id'] in complete
            cohort.append({'id':row['id'],'project':project,'eligible':eligible})
            if eligible:cases.append(complete[row['id']])
    methods=['default','coverage','conditional'];rng=random.Random(20260919)
    (ROOT/'docs/CONFIRMATION_TIMING_COHORT.json').write_text(json.dumps({'cohort':cohort,'methods':methods,'repetitions':3},indent=2))
    jobs=[]
    for repeat in range(3):
        block=cases.copy();rng.shuffle(block)
        for r in block:
            ordered=methods.copy();rng.shuffle(ordered)
            for method in ordered:jobs.append((repeat,r,method))
    records=[];dest=ROOT/'results/confirmation_timing_records.jsonl'
    if dest.exists():raise ValueError('immutable timing output already exists')
    for i,(rep,oracle,method) in enumerate(jobs):
        row=oracle['mutation'];start=time.perf_counter();order=models[row['project']].order(row['source'],method);planning=time.perf_counter()-start
        r=run_one(row,mode=method,order=order,repeat=rep)
        record={'id':row['id'],'project':row['project'],'method':method,'repeat':rep,'seconds':r['end_to_end_seconds']+planning,
                'order_planning_seconds':planning,'executed':len(r['executed']),'oracle_code':oracle['returncode'],
                'actual_code':r['returncode'],'timeout':r['timed_out'],'same_verdict':r['returncode']==oracle['returncode']}
        records.append(record)
        with dest.open('a') as f:f.write(json.dumps(record)+'\n')
        print(i+1,'/',len(jobs),row['id'],method,rep,round(record['seconds'],3),record['actual_code'],flush=True)
    (ROOT/'results/confirmation_timing_raw.json').write_text(json.dumps(records,indent=2))
if __name__=='__main__':main()
