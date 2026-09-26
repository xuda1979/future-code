"""Frozen-seed experiments for order robustness and priced online switching."""
from __future__ import annotations
import argparse,json,time
from pathlib import Path
import numpy as np
from hact.tree import compact_balanced,stats,CostModel
from ichact.layout import Layout,fit_catalogue,select_validation,fit_layout
from ichact.online import CoupledShare,migration_matrix,offline_oracle,tracking_bound
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'results/v3';OUT.mkdir(parents=True,exist_ok=True)


def draw(rng,n,count,kind,permutation=None):
    perm=list(range(n)) if permutation is None else list(permutation)
    groups=[perm[i:i+8] for i in range(0,n,8)]
    result=[]
    for _ in range(count):
        if kind=='cluster':
            group=groups[int(rng.integers(len(groups)))]
            wave=list(group)
            if rng.random()<.12:wave.append(int(rng.integers(n)))
        elif kind=='independent':wave=np.flatnonzero(rng.random(n)<8/n).tolist()
        elif kind=='singleton':
            weights=1/(1+np.arange(n))**1.2;weights/=weights.sum();wave=[int(rng.choice(n,p=weights))]
        elif kind=='global':wave=list(range(n))
        else:raise ValueError(kind)
        result.append([sorted(set(wave))])
    return result


def write(name,value):
    (OUT/name).write_text(json.dumps(value,indent=2,allow_nan=False))


def ordering(seeds=20,n=64):
    rows=[];raw=OUT/'ordering';raw.mkdir(exist_ok=True)
    for kind in ('cluster','independent','singleton','global'):
        for seed in range(seeds):
            rng=np.random.default_rng(10000+seed);perm=list(map(int,rng.permutation(n)))
            train=draw(rng,n,256,kind,perm);val=draw(rng,n,128,kind,perm);test=draw(rng,n,512,kind,perm)
            registry=tuple(f'obligation-{i:04d}' for i in range(n))
            start=time.perf_counter();cat=fit_catalogue(registry,train);fitsec=time.perf_counter()-start
            choice,vals=select_validation(cat,val)
            cat['fixed8']=Layout(registry,tuple(range(n)),compact_balanced(n,8))
            totals={name:sum(layout.cost(ep) for ep in test) for name,layout in cat.items()}
            totals['selected']=totals[choice]
            incremental={name:sum(layout.cost(ep,initial=False) for ep in test) for name,layout in cat.items()}
            item={'kind':kind,'seed':seed,'n':n,'selected':choice,'validation_scores':vals,'total_bytes':totals,'incremental_bytes':incremental,'fit_seconds':fitsec}
            rows.append(item)
            (raw/f'{kind}-{seed:02d}.json').write_text(json.dumps({'training':train,'validation':val,'test':test,'layouts':{k:l.to_dict() for k,l in cat.items()},'summary':item},separators=(',',':')))
        print('ordering',kind,'done',flush=True)
    write('ordering_summary.json',rows)


def efficient_costs(layouts,episodes,initial=False):
    cover=[l.coverage() for l in layouts]
    base=np.array([sum(price for _,price in c) if initial else 0 for c in cover])
    result=[]
    for ep in episodes:
        row=base.copy()
        for wave in ep:
            mask=sum(1<<i for i in set(wave))
            for j,c in enumerate(cover):row[j]+=sum(price for covered,price in c if mask&covered)
        result.append(row)
    return np.array(result,dtype=float)


def online(seeds=20,n=64):
    rows=[];raw=OUT/'online';raw.mkdir(exist_ok=True)
    for seed in range(seeds):
        rng=np.random.default_rng(30000+seed);perm=list(map(int,rng.permutation(n)))
        registry=tuple(f'obligation-{i:04d}' for i in range(n))
        # Four explicit calibration regimes exist before all evaluation streams.
        calibration=[draw(rng,n,256,'cluster'),draw(rng,n,256,'cluster',perm),draw(rng,n,256,'independent'),draw(rng,n,256,'global')]
        layouts=[fit_layout(registry,calibration[0]),fit_layout(registry,calibration[1],perm),fit_layout(registry,calibration[2]),fit_layout(registry,calibration[3])]
        unique={l.uid:l for l in layouts};layouts=list(unique.values());k=len(layouts)
        mig=migration_matrix(layouts)
        # At most one frontier per event. This is a persistent-state refresh
        # trace; cold migrations are charged in addition to service bytes.
        loss_range=float(max(sum(p for _,p in l.coverage()) for l in layouts))
        frozen=int(efficient_costs(layouts,calibration[0]).sum(axis=0).argmin())
        for mode in ('stationary','long_shift','rapid_shift','global'):
            if mode=='stationary':episodes=draw(rng,n,2048,'cluster')
            elif mode=='global':episodes=draw(rng,n,2048,'global')
            elif mode=='long_shift':episodes=draw(rng,n,512,'cluster')+draw(rng,n,512,'cluster',perm)+draw(rng,n,512,'independent')+draw(rng,n,512,'global')
            else:
                episodes=[]
                for block in range(256):episodes+=draw(rng,n,8,'cluster',perm if block%2 else None)
            start=time.perf_counter();costs=efficient_costs(layouts,episodes);scoresec=time.perf_counter()-start
            methods={};actions={}
            for name,share,coupled in [('coupled_share',.01,True),('independent_share',.01,False),('coupled_static',0,True)]:
                c=CoupledShare(k,loss_range,mig,eta=.5,share=share,seed=70000+seed,coupled=coupled)
                seq=[];start=time.perf_counter()
                for vector in costs:seq.append(c.choose());c.observe(vector)
                methods[name]={'service_bytes':c.service,'switch_bytes':c.switch_cost,'total_bytes':c.service+c.switch_cost,
                    'switches':c.switches,'controller_seconds':time.perf_counter()-start}
                actions[name]=seq
            # Deterministic window rule, with explicit hysteresis and no theorem.
            for name,window,priced in [('window_priced',64,True),('greedy_unpriced',1,False)]:
                active=frozen;seq=[];service=sw=0;changes=0
                for t,vector in enumerate(costs):
                    if t:
                        means=costs[max(0,t-window):t].mean(axis=0)
                        candidate=int(means.argmin())
                        if not priced or window*(means[active]-means[candidate])>mig[active,candidate]:
                            sw+=mig[active,candidate];changes+=int(candidate!=active);active=candidate
                    seq.append(active);service+=vector[active]
                methods[name]={'service_bytes':float(service),'switch_bytes':float(sw),'total_bytes':float(service+sw),'switches':changes}
                actions[name]=seq
            fixed=float(costs[:,frozen].sum());best_static=float(costs.sum(axis=0).min())
            opt,path=offline_oracle(costs,mig)
            methods['frozen']={'total_bytes':fixed,'service_bytes':fixed,'switch_bytes':0,'switches':0}
            methods['best_static_hindsight']={'total_bytes':best_static}
            methods['switching_oracle_hindsight']={'total_bytes':opt,'switches':sum(a!=b for a,b in zip(path,path[1:]))}
            item={'seed':seed,'mode':mode,'n':n,'k':k,'events':len(costs),'loss_range':loss_range,'max_migration':float(mig.max()),'full_information_scoring_seconds':scoresec,'methods':methods,'bound_vs_3switch_service':tracking_bound(len(costs),k,loss_range,float(mig.max()),.5,.01,3)}
            rows.append(item)
            (raw/f'{mode}-{seed:02d}.json').write_text(json.dumps({'layouts':[l.to_dict() for l in layouts],'waves':episodes,'costs':costs.tolist(),'migration':mig.tolist(),'frozen_index':frozen,'actions':actions,'oracle_actions':path,'summary':item},separators=(',',':')))
        print('online seed',seed,'done',flush=True)
    write('online_summary.json',rows)


def scaling():
    rows=[]
    for n in (32,64,128,256,512):
        rng=np.random.default_rng(80000+n);perm=list(map(int,rng.permutation(n)))
        episodes=draw(rng,n,128,'cluster',perm)
        start=time.perf_counter();cat=fit_catalogue(tuple(f'g{i}' for i in range(n)),episodes);elapsed=time.perf_counter()-start
        rows.append({'n':n,'catalogue_size':len(cat),'total_fit_seconds':elapsed,'largest_packet_bytes':max(stats(l.tree,l.model)['max_packet_bytes'] for l in cat.values())})
        print('scaling',rows[-1],flush=True)
    write('scaling.json',rows)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('mode',choices=['ordering','online','scaling']);p.add_argument('--seeds',type=int,default=20);p.add_argument('--n',type=int,default=64);a=p.parse_args()
    globals()[a.mode](**({} if a.mode=='scaling' else {'seeds':a.seeds,'n':a.n}))
