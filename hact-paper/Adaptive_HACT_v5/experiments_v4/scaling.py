"""Frozen block compiler study. All timing excludes source checking/LLMs.
Order-learning time is separate; exact-vs-block uses the SAME learned order.
"""
import json,time
from pathlib import Path
import numpy as np
from hact.tree import stats,compact_balanced
from ichact.layout import jaccard_affinity,cluster_order,fit_layout,Layout
from ichact.blocked import fit_blocked
from experiments_v3.bench import draw
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'results/v4'


def main():
    data=[]
    for n in (128,512,1024):
        for kind in ('cluster','independent'):
            for seed in (44011,44012,44013):
                rng=np.random.default_rng(seed);latent=list(map(int,rng.permutation(n)))
                train=draw(rng,n,128,kind,latent);test=draw(rng,n,256,kind,latent)
                reg=tuple(f'obligation-{i:04d}' for i in range(n))
                start=time.perf_counter();order=cluster_order(jaccard_affinity(train,n));order_sec=time.perf_counter()-start
                start=time.perf_counter();blocked=fit_blocked(reg,train,order,block_size=32);block_sec=time.perf_counter()-start
                layouts={'blocked32':blocked,'fixed8_original':Layout(reg,tuple(range(n)),compact_balanced(n,8)),
                         'fixed8_learned':Layout(reg,order,compact_balanced(n,8))}
                exact_sec=None
                if n<=512:
                    start=time.perf_counter();layouts['exact']=fit_layout(reg,train,order);exact_sec=time.perf_counter()-start
                train_cost={k:sum(l.cost(ep) for ep in train)/len(train) for k,l in layouts.items()}
                test_cost={k:sum(l.cost(ep) for ep in test)/len(test) for k,l in layouts.items()}
                if 'exact' in layouts:assert train_cost['blocked32']+1e-7>=train_cost['exact']
                row={'n':n,'kind':kind,'seed':seed,'order_seconds':order_sec,'blocked_fit_seconds':block_sec,'exact_fit_seconds':exact_sec,
                     'train_cost':train_cost,'heldout_cost':test_cost,'blocked_stats':stats(blocked.tree,blocked.model),
                     'order':list(order),'training':train,'heldout':test,'layouts':{k:l.to_dict() for k,l in layouts.items()}}
                data.append(row);(OUT/'scaling.json').write_text(json.dumps(data,separators=(',',':')))
                print(n,kind,seed,'order',round(order_sec,3),'block',round(block_sec,3),'exact',None if exact_sec is None else round(exact_sec,3),flush=True)
if __name__=='__main__':main()
