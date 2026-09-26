"""Local, synthetic invalidation workloads; no model calls and no semantic scores."""
from __future__ import annotations
import argparse
from dataclasses import asdict
import json
from pathlib import Path
import time
import numpy as np
from hact.tree import (CostModel, activation_matrix, independence_matrix, optimize,
                       compact_balanced, objective, stats)

FAMILIES = ('singleton', 'skewed', 'independent', 'clustered', 'mixed', 'global')


def grouping(n: int, seed: int) -> list[list[int]]:
    rng = np.random.default_rng(np.random.SeedSequence([7001,seed,n]))
    groups=[];start=0
    while start<n:
        size=min(n-start,int(rng.integers(3,13)))
        groups.append(list(range(start,start+size)));start+=size
    return groups


def episodes(n: int, family: str, seed: int, count: int, stream: int) -> list[list[int]]:
    rng=np.random.default_rng(np.random.SeedSequence([260918,n,seed,stream]))
    groups=grouping(n,seed)
    weights=(np.arange(len(groups))+1.0)**(-0.8);weights/=weights.sum()
    leafweights=(np.arange(n)+1.0)**(-1.1);leafweights/=leafweights.sum()
    out=[]
    for _ in range(count):
        if family=='singleton': ids=[int(rng.integers(n))]
        elif family=='skewed': ids=[int(rng.choice(n,p=leafweights))]
        elif family=='independent': ids=np.flatnonzero(rng.random(n)<4/n).tolist()
        elif family=='global': ids=list(range(n))
        elif family in {'clustered','mixed'}:
            u=rng.random()
            if family=='mixed' and u<.1: ids=list(range(n))
            elif u<(.4 if family=='mixed' else .2): ids=[int(rng.integers(n))]
            else: ids=groups[int(rng.choice(len(groups),p=weights))].copy()
        else: raise ValueError(family)
        out.append(ids)
    return out


def to_active(data: list[list[int]], n: int) -> np.ndarray:
    a=np.zeros((len(data),n),dtype=bool)
    for i,ids in enumerate(data): a[i,ids]=True
    return a


def costs(tree, data, n, model):
    prefix=np.column_stack((np.zeros(len(data),dtype=np.int64),to_active(data,n).cumsum(axis=1)))
    cost=np.zeros(len(data),dtype=np.int64);calls=cost.copy()
    for v in tree.walk():
        if not v.leaf:
            active=prefix[:,v.hi+1]>prefix[:,v.lo]
            cost+=active*model.packet_bytes(len(v.children));calls+=active
    return cost,calls


def one(n, family, seed, outdir, train_n=512, test_n=2048, model=CostModel()):
    training=episodes(n,family,seed,train_n,0)
    test=episodes(n,family,seed,test_n,1)
    p=activation_matrix(training,n)
    begin=time.perf_counter();hact,value=optimize(p,model);planner=time.perf_counter()-begin
    begin=time.perf_counter();marginal,_=optimize(independence_matrix(p),model);margtime=time.perf_counter()-begin
    fixed={b:compact_balanced(n,b) for b in range(2,model.fanout+1)}
    selected=min(fixed,key=lambda b:objective(fixed[b],p,model))
    trees={'fixed2':fixed[2],'fixed4':fixed[min(4,model.fanout)],
           'fixed8':fixed[min(8,model.fanout)],'tuned_fixed':fixed[selected],
           'marginal':marginal,'hact':hact}
    arrays={'train_active':to_active(training,n),'test_active':to_active(test,n)}
    record={'n':n,'family':family,'seed':seed,'train_episodes':train_n,'test_episodes':test_n,
            'model':asdict(model),'selected_fixed_arity':selected,'hact_plan_seconds':planner,
            'marginal_plan_seconds':margtime,'mean_invalidated_gates':float(np.mean([len(s) for s in test])),
            'trees':{name:tree.to_dict() for name,tree in trees.items()},'methods':{}}
    for name,tree in trees.items():
        values,calls=costs(tree,test,n,model)
        arrays[name+'_bytes']=values;arrays[name+'_refreshes']=calls
        record['methods'][name]={'mean_bytes':float(values.mean()),'mean_refreshes':float(calls.mean()),
                                  'training_objective':objective(tree,p,model),**stats(tree,model)}
    prefix=outdir/f'{family}_n{n}_s{seed}'
    prefix.with_suffix('.json').write_text(json.dumps(record,indent=2)+'\n')
    np.savez_compressed(prefix.with_suffix('.npz'),**arrays)
    return record


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--family',choices=FAMILIES,required=True)
    ap.add_argument('--n',type=int,default=128);ap.add_argument('--seeds',type=int,default=20)
    ap.add_argument('--seed-start',type=int,default=0);ap.add_argument('--out',type=Path,default=Path('results/synthetic'))
    args=ap.parse_args();args.out.mkdir(parents=True,exist_ok=True)
    data=[]
    for seed in range(args.seed_start,args.seed_start+args.seeds):
        r=one(args.n,args.family,seed,args.out);data.append(r)
    print(json.dumps({'family':args.family,'n':args.n,'seeds':args.seeds,
                      'mean_bytes':{m:np.mean([r['methods'][m]['mean_bytes'] for r in data]) for m in data[0]['methods']},
                      'hact_planner_seconds':np.mean([r['hact_plan_seconds'] for r in data])},indent=2))

if __name__=='__main__': main()
