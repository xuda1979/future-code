"""Sequential randomized-block end-to-end timing, with three repetitions.
Timing cohort: first eight held-out IDs per project, independent of method outcomes.
The one full-oracle timeout is retained as UNKNOWN but has no finite latency comparison.
"""
from __future__ import annotations
import json
import random
import time
from experiments.runner import ROOT
from experiments.analyze import load
from experiments.mutations import run_one
from experiments.benchmarks import SCOPES

METHODS=['default','coverage','global','conditional']

def main():
    rng=random.Random(20260918)
    cohort=[];models={};complete={}
    for project in SCOPES:
        base,reports,valid,training,model=load(project);models[project]=model
        chosen=sorted((r for r in reports if r['mutation']['split']=='test'),key=lambda r:r['mutation']['id'])[:8]
        for r in chosen:
            isvalid=r in valid
            cohort.append({'id':r['mutation']['id'],'project':project,'eligible':isvalid,
                           'reason':'complete oracle' if isvalid else 'incomplete or timed-out oracle'})
            if isvalid:complete[r['mutation']['id']]=r
    (ROOT/'docs/TIMING_COHORT.json').write_text(json.dumps({'repetitions':3,'methods':METHODS,'cohort':cohort,'order_seed':20260918},indent=2))
    jobs=[]
    for rep in range(3):
        cases=list(complete.values());rng.shuffle(cases)
        for r in cases:
            methods=METHODS.copy();rng.shuffle(methods)
            for method in methods:jobs.append((rep,r,method))
    records=[]
    for index,(rep,oracle,method) in enumerate(jobs):
        row=oracle['mutation'];start=time.perf_counter();order=models[row['project']].order(row['source'],method)
        planning=time.perf_counter()-start
        r=run_one(row,mode=method,order=order,repeat=rep)
        record={'id':row['id'],'project':row['project'],'method':method,'repeat':rep,'seconds':r['end_to_end_seconds']+planning,
                'order_planning_seconds':planning,'executed':len(r['executed']),'oracle_code':oracle['returncode'],
                'actual_code':r['returncode'],'timeout':r['timed_out'],'same_verdict':r['returncode']==oracle['returncode']}
        records.append(record)
        with (ROOT/'results/timing_records.jsonl').open('a') as f:f.write(json.dumps(record)+'\n')
        print(index+1,'/',len(jobs),row['id'],method,rep,round(record['seconds'],3),record['actual_code'],flush=True)
    (ROOT/'results/timing_summary_raw.json').write_text(json.dumps(records,indent=2))
if __name__=='__main__':main()
