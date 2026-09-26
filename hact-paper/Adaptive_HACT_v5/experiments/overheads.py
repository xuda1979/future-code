"""Post-primary sensitivity checks; not used for model selection."""
from pathlib import Path
import json,time,statistics
from experiments.runner import ROOT
from experiments.analyze import load
from experiments.benchmarks import SCOPES
from experiments.evaluate_frozen import decode
from ichact.guard import EpochGuard
from ichact.frontier import completion_waves,frontier_bytes,fit_frontiers
from hact.tree import compact_balanced
from hact.certificates import digest

def main():
    plans=json.loads((ROOT/'results/plans.json').read_text());result=[]
    for project in SCOPES:
        base,reports,valid,training,model=load(project);registry=base['registry'];index={g:i for i,g in enumerate(registry)};n=len(registry)
        tree=decode(plans[project]['shared']['pooled_frontier']);timings=[]
        for rep in range(5):
            begin=time.perf_counter();guard=EpochGuard(registry,digest('snapshot'),digest('checker'),digest('env'));_,packets=guard.refresh(tree);bytes_=sum(map(len,packets))
            for start in range(0,n,8):
                for i in range(start,min(start+8,n)):guard.submit(guard.token(i),'PASS',digest(i))
                _,packets=guard.refresh(tree);bytes_+=sum(map(len,packets))
            assert guard.authorize(guard.issue());timings.append(time.perf_counter()-begin)
        for width in [1,8,32,n]:
            eps=[]
            for r in training:
                pi=[index[g] for g in model.order(r['mutation']['source'])]
                eps.append(completion_waves(pi,{index[g] for g,v in r['records'].items() if v['status']=='FAIL'},width))
            begin=time.perf_counter();fitted,_=fit_frontiers(eps,n);fit=time.perf_counter()-begin
            tests=[r for r in valid if r['mutation']['split']=='confirmation'];fixed=compact_balanced(n,8)
            costs=[]
            for r in tests:
                pi=[index[g] for g in model.order(r['mutation']['source'])]
                waves=completion_waves(pi,{index[g] for g,v in r['records'].items() if v['status']=='FAIL'},width)
                costs.append({'id':r['mutation']['id'],'fitted':frontier_bytes(fitted,waves),'fixed':frontier_bytes(fixed,waves)})
            result.append({'project':project,'width':width,'fit_seconds':fit,'costs':costs,'synthetic_all_pass_kernel_median_seconds':statistics.median(timings),'kernel_repeats':5})
    (ROOT/'results/overheads.json').write_text(json.dumps(result,indent=2));print('overheads and batching complete',flush=True)
if __name__=='__main__':main()
