"""Evaluate immutable pilot-fitted plans on both pilot and fresh confirmation.
No fitting in this file; all ranking observations remain original training only.
"""
from __future__ import annotations
import json
import hashlib
import time
from hact.tree import Node, CostModel, stats
from ichact.frontier import completion_waves
from experiments.runner import ROOT
from experiments.analyze import load, trace_order, verify_packets, METHODS
from experiments.benchmarks import SCOPES

def decode(row):
    return Node(row['lo'],row['hi'],tuple(decode(x) for x in row['children']))

def main():
    contract=json.loads((ROOT/'docs/CONFIRMATION_PLAN.json').read_text())
    assert hashlib.sha256((ROOT/'results/plans.json').read_bytes()).hexdigest()==contract['frozen_plans_sha256']
    plans=json.loads((ROOT/'results/plans.json').read_text());result=[];meta={}
    for project in SCOPES:
        base,reports,valid,training,model=load(project);registry=base['registry'];index={g:i for i,g in enumerate(registry)}
        p=plans[project];shared={k:decode(v) for k,v in p['shared'].items()};context={k:decode(v) for k,v in p['conditional'].items()}
        meta[project]={'registry':len(registry),'training':len(training),'valid':len(valid),'total':len(reports)}
        for r in valid:
            phase=r['mutation']['split']
            if phase not in ('test','confirmation'):continue
            source=r['mutation']['source'];row={'id':r['mutation']['id'],'project':project,'source':source,
                 'phase':'development' if phase=='test' else 'confirmation','oracle_fail':r['returncode']==1,
                 'registry':len(registry),'scheduling':{},'certificates':{}}
            for method in METHODS:
                start=time.perf_counter();order=model.order(source,method);planning=time.perf_counter()-start
                executed=trace_order(r,order)
                row['scheduling'][method]={'tests':len(executed),'order':order,'planning_seconds':planning,
                     'replayed_service_seconds':sum(sum(x['seconds'] for x in r['records'][g]['phases'].values()) for g in executed)}
            waves=completion_waves([index[g] for g in row['scheduling']['conditional']['order']],
                   {index[g] for g,v in r['records'].items() if v['status']=='FAIL'},8);row['waves']=waves
            for name,tree in {**shared,'conditional_frontier':context.get(source,shared['pooled_frontier'])}.items():
                measured=verify_packets(r,registry,tree,waves);measured.update(stats(tree,CostModel()))
                assert (measured['verdict']=='FAIL')==row['oracle_fail'];row['certificates'][name]=measured
            # Adversarial replay only: a deliberately unsafe reuse policy, not NameRTS.
            prof=json.loads((ROOT/'results/baselines'/f'{"future_core" if project=="future" else project}_profile.json').read_text())
            coverage={g for g in registry if source in prof['records'][g]['dependencies']}
            # The omission mask is outcome-independent and intentionally severe.
            pruned={g for g in coverage if int(hashlib.sha256(('edge-mask:'+source+g).encode()).hexdigest(),16)%4==0}
            fails={g for g,v in r['records'].items() if v['status']=='FAIL'}
            row['unsafe_reuse_ablation']={'coverage_false_pass':bool(fails and not(fails&coverage)),
                 'pruned_false_pass':bool(fails and not(fails&pruned)),'selected_coverage':len(coverage),'selected_pruned':len(pruned)}
            result.append(row)
        print(project,meta[project],flush=True)
    (ROOT/'results/frozen_evaluation.json').write_text(json.dumps({'meta':meta,'episodes':result},indent=2))
    print('Recorded episodes',len(result),flush=True)
if __name__=='__main__':main()
