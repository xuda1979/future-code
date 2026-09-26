"""New, frozen-seed held-out study of the no-DP default catalogue."""
from pathlib import Path
import argparse,json,time
import numpy as np
from ichact.practical import practical_catalogue
from experiments_v3.bench import draw, efficient_costs
ROOT=Path(__file__).resolve().parents[1]

def main():
    out=ROOT/'results/v5';out.mkdir(exist_ok=True)
    contract=json.loads((ROOT/'docs/V5_EXPERIMENT_CONTRACT.json').read_text())['new_synthetic']
    parser=argparse.ArgumentParser();parser.add_argument('--resume',action='store_true');args=parser.parse_args()
    destination=out/'practical.json'
    if destination.exists() and not args.resume:raise ValueError('existing observations require explicit --resume')
    rows=json.loads(destination.read_text()) if args.resume and destination.exists() else []
    completed={(r['n'],r['kind'],r['seed']) for r in rows}
    if len(completed)!=len(rows):raise ValueError('duplicate recorded experiment')
    for n in contract['n']:
        for kind in contract['families']:
            for seed in contract['seeds']:
                if (n,kind,seed) in completed:continue
                rng=np.random.default_rng(seed);latent=list(map(int,rng.permutation(n)))
                train=draw(rng,n,contract['train_epochs'],kind,latent)
                valid=draw(rng,n,contract['validation_epochs'],kind,latent)
                test=draw(rng,n,contract['heldout_epochs'],kind,latent)
                ids=tuple(f'obligation-{i:04d}' for i in range(n))
                t=time.perf_counter();cat=practical_catalogue(ids,train);fit=time.perf_counter()-t
                names=list(cat);vals=efficient_costs(list(cat.values()),valid,initial=True).sum(axis=0)
                selected=names[int(vals.argmin())]
                tests=efficient_costs(list(cat.values()),test,initial=True).sum(axis=0)
                rows.append(dict(n=n,kind=kind,seed=seed,selected=selected,fit_seconds=fit,
                    train=train,validation=valid,heldout=test,layouts={k:l.to_dict() for k,l in cat.items()},
                    validation_totals=dict(zip(names,map(int,vals))),heldout_totals=dict(zip(names,map(int,tests)))))
                (out/'practical.json').write_text(json.dumps(rows,separators=(',',':')))
                print(n,kind,seed,selected,round(fit,3),flush=True)
if __name__=='__main__':main()
