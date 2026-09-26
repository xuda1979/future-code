from __future__ import annotations
import json
from pathlib import Path
import time
import hashlib
import numpy as np
from hact.tree import compact_balanced,optimize,CostModel,stats
from hact.certificates import digest
from ichact.impact import ImpactModel,Intervention
from ichact.frontier import completion_waves,fit_frontiers,frontier_bytes,full_bytes
from ichact.guard import EpochGuard
from experiments.runner import ROOT
from experiments.benchmarks import SCOPES
from functools import lru_cache
from ichact.identity import source_manifest, canonical, checker_identity, environment_identity

METHODS=['default','shortest','coverage','global','conditional']

def load(project):
    prefix='future_core' if project=='future' else project
    base=json.loads((ROOT/'results/baselines'/f'{prefix}_plain.json').read_text())
    profile=json.loads((ROOT/'results/baselines'/f'{prefix}_profile.json').read_text())
    reports=[]
    for p in sorted((ROOT/'results/mutations').glob(f'{project}_*.json')):
        r=json.loads(p.read_text());reports.append(r)
    def valid(r):
        return (not r['timed_out'] and not r['collection_errors'] and r['returncode'] in (0,1)
            and r['registry']==base['registry'] and set(r['records'])==set(base['registry'])
            and all(x['status'] in ('PASS','FAIL') for x in r['records'].values()))
    valid_reports=[r for r in reports if valid(r)]
    training=[r for r in valid_reports if r['mutation']['split']=='train']
    costs={g:sum(v['seconds'] for v in rec['phases'].values()) for g,rec in base['records'].items()}
    calls={g:rec['dependencies'] for g,rec in profile['records'].items()}
    interventions=[Intervention(r['mutation']['source'],frozenset(g for g,v in r['records'].items() if v['status']=='FAIL'),r['mutation']['id']) for r in training]
    model=ImpactModel(base['registry'],costs,calls,interventions)
    return base,reports,valid_reports,training,model

def trace_order(r,order):
    executed=[]
    for g in order:
        executed.append(g)
        if r['records'][g]['status']=='FAIL':break
    return executed

@lru_cache(maxsize=None)
def frozen_source_identity(project):
    return source_manifest(ROOT/'vendor'/project)

@lru_cache(maxsize=1)
def runtime_identities():
    return checker_identity(),canonical(environment_identity())

def verify_packets(r,registry,tree,waves):
    manifest=dict(frozen_source_identity(r['project']))
    assert manifest[r['mutation']['source']]==r['mutation']['base_sha256']
    manifest[r['mutation']['source']]=r['mutation']['mutant_sha256']
    snapshot=canonical(manifest)
    checker,environment=runtime_identities()
    g=EpochGuard(registry,snapshot,checker,environment)
    root,packets=g.refresh(tree);total=sum(map(len,packets));maximum=max(map(len,packets),default=0)
    for wave in waves:
        for i in wave:
            rec=r['records'][registry[i]]
            g.submit(g.token(i),rec['status'],digest(rec))
        root,packets=g.refresh(tree);total+=sum(map(len,packets));maximum=max(maximum,max(map(len,packets),default=0))
    if root.verdict=='PASS':assert g.authorize(g.issue())
    else:
        try:g.issue()
        except ValueError:pass
        else:raise AssertionError('non-PASS published')
    assert total==frontier_bytes(tree,waves)
    return {'snapshot_identity':snapshot,'checker_identity':checker,'environment_identity':environment,'actual_bytes':total,'maximum_packet':maximum,'verdict':root.verdict,'counts':list(root.counts)}

def run():
    result=[];meta={};plan_records={}
    for project in SCOPES:
        base,reports,valid,training,model=load(project);registry=base['registry'];index={g:i for i,g in enumerate(registry)};n=len(registry)
        episodes=[];bysource={}
        started=time.perf_counter()
        for r in training:
            source=r['mutation']['source'];order=model.order(source,'conditional')
            waves=completion_waves([index[g] for g in order],{index[g] for g,v in r['records'].items() if v['status']=='FAIL'},8)
            episodes.append(waves);bysource.setdefault(source,[]).append(waves)
        trees={'fixed8':compact_balanced(n,8),'invalidation_only':optimize(np.triu(np.ones((n,n))))[0],
               'pooled_frontier':fit_frontiers(episodes,n)[0]}
        contextual={s:fit_frontiers(eps,n)[0] for s,eps in bysource.items()}
        fit_seconds=time.perf_counter()-started
        plans={'shared':{k:v.to_dict() for k,v in trees.items()},'conditional':{k:v.to_dict() for k,v in contextual.items()}}
        plan_records[project]=plans
        meta[project]={'registry_size':n,'train_snapshots':len(training),'test_total':sum(r['mutation']['split']=='test' for r in reports),
                       'test_valid':sum(r['mutation']['split']=='test' for r in valid),'fit_seconds':fit_seconds,
                       'frontier_width':8,'registry_sha256':digest(registry),'mutated_sources':len({r['mutation']['source'] for r in reports})}
        for r in valid:
            if r['mutation']['split']!='test':continue
            source=r['mutation']['source'];row={'id':r['mutation']['id'],'project':project,'source':source,
                'oracle_fail':r['returncode']==1,'registry':n,'scheduling':{},'certificates':{}}
            for method in METHODS:
                start=time.perf_counter();order=model.order(source,method);schedule_seconds=time.perf_counter()-start
                visited=trace_order(r,order)
                cost=sum(sum(v['seconds'] for v in r['records'][g]['phases'].values()) for g in visited)
                row['scheduling'][method]={'tests':len(visited),'replayed_service_seconds':cost,'order':order,'planning_seconds':schedule_seconds}
            pi=[index[g] for g in row['scheduling']['conditional']['order']]
            waves=completion_waves(pi,{index[g] for g,v in r['records'].items() if v['status']=='FAIL'},8)
            row['waves']=waves
            for name,tree in {**trees,'conditional_frontier':contextual.get(source,trees['pooled_frontier'])}.items():
                measured=verify_packets(r,registry,tree,waves)
                measured.update(stats(tree,CostModel()))
                assert (measured['verdict']=='FAIL')==row['oracle_fail']
                row['certificates'][name]=measured
            result.append(row)
        print(project,meta[project],flush=True)
    (ROOT/'results/replay.json').write_text(json.dumps({'meta':meta,'episodes':result},indent=2))
    (ROOT/'results/plans.json').write_text(json.dumps(plan_records,indent=2))
    print('Heldout replay episodes',len(result),flush=True)
if __name__=='__main__':run()
