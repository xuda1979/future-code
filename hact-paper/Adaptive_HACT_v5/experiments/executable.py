"""Executable mutation microbenchmark, not an LLM or SWE-bench experiment.

Every snapshot is checked by a fresh Python subprocess on immutable source strings.
A selective check is compared with a separately launched full-registry check.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import numpy as np
from hact.certificates import Gate, Evidence, Kernel, digest
from hact.tree import (CostModel, activation_matrix, independence_matrix, optimize,
                       compact_balanced, objective, episode_cost, stats)

from .fixture_checker import MODULES, definitions


def source(i, revision, broken=False):
    return f'# Fixture revision {revision}; generated for controlled mutation.\ndef transform(x):\n    return x + {i + int(broken)}\n'


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def check(sources, gates):
    result=subprocess.run([sys.executable, str(Path(__file__).with_name('fixture_checker.py'))],
                          input=json.dumps({'sources':sources,'gates':sorted(gates)}),
                          text=True,capture_output=True,timeout=20,check=True)
    return json.loads(result.stdout)


def module_set(rng):
    weights=(np.arange(MODULES)+1.)**(-.8);weights/=weights.sum()
    start=int(rng.choice(MODULES,p=weights));length=int(rng.integers(1,4))
    return list(range(start,min(MODULES,start+length)))


def affected(modules):
    touched=set(modules)
    return [i for i,d in enumerate(definitions()) if d['module'] in touched or d.get('other') in touched]


def one(seed, outdir, pairs=16, max_new_pairs=None):
    model=CostModel();n=len(definitions())
    train_rng=np.random.default_rng(np.random.SeedSequence([83012,seed,0]))
    run_rng=np.random.default_rng(np.random.SeedSequence([83012,seed,1]))
    training=[affected(module_set(train_rng)) for _ in range(512)]
    p=activation_matrix(training,n)
    trees={f'fixed{b}':compact_balanced(n,b) for b in (4,8)}
    all_fixed={b:compact_balanced(n,b) for b in range(2,9)}
    best=min(all_fixed,key=lambda b:objective(all_fixed[b],p,model))
    trees['tuned_fixed']=all_fixed[best]
    trees['marginal']=optimize(independence_matrix(p),model)[0]
    trees['hact']=optimize(p,model)[0]
    sources=[source(i,0) for i in range(MODULES)]
    artifacts={f'mod{i:02d}.py':sha(s) for i,s in enumerate(sources)}
    artifacts['checker']=sha(Path(__file__).with_name('fixture_checker.py').read_text())
    artifacts['runtime']=sha(sys.version)
    gates=[]
    for i,d in enumerate(definitions()):
        deps=[f"mod{d['module']:02d}.py"]
        if d['kind']=='integration':deps.append(f"mod{d['other']:02d}.py")
        gates.append(Gate(f'G{i:03d}',tuple(deps+['checker','runtime'])))
    initial=check(sources,range(n))
    assert all(r['status']=='PASS' for r in initial)
    kernels={name:Kernel(gates,artifacts,model) for name in trees}
    for name,kernel in kernels.items():
        for record in initial:
            i=record['gate'];kernel.submit_trusted(i,Evidence(kernel.gate_binding(i),record['status'],digest(record)))
        root,_=kernel.refresh(trees[name]);assert root.verdict=='PASS'
    outdir.mkdir(parents=True,exist_ok=True)
    journal=outdir/f'seed{seed}.jsonl'
    previous=[json.loads(line) for line in journal.read_text().splitlines()] if journal.exists() else []
    rows=[]
    target=pairs if max_new_pairs is None else min(pairs,(len(previous)+1)//2+max_new_pairs)
    for pair in range(target):
        changed=module_set(run_rng)
        for phase in ('fault','repair'):
            revision=pair*2+(1 if phase=='fault' else 2)
            for i in changed:sources[i]=source(i,revision,phase=='fault' and i==changed[0])
            changes={f'mod{i:02d}.py':sha(sources[i]) for i in changed}
            changed_gates=affected(changed)
            idx=pair*2+(phase=='repair')
            if idx<len(previous):
                old=previous[idx]
                assert old['sources']==sources and old['invalidated']==changed_gates
                selective=old['selective'];full=old['full_oracle']
            else:
                selective=check(sources,changed_gates)
                full=check(sources,range(n))
            full_map={r['gate']:r for r in full}
            assert all(r==full_map[r['gate']] for r in selective)
            expected='FAIL' if any(r['status']=='FAIL' for r in full) else 'PASS'
            assert expected==('FAIL' if phase=='fault' else 'PASS')
            measurements={}
            for name,kernel in kernels.items():
                stale=kernel.ticket()
                invalidated=kernel.update_artifacts(changes)
                assert invalidated==set(changed_gates)
                assert not kernel.publish(stale)
                for record in selective:
                    i=record['gate']
                    kernel.submit_trusted(i,Evidence(kernel.gate_binding(i),record['status'],digest(record)))
                root,packets=kernel.refresh(trees[name])
                assert root.verdict==expected
                assert kernel.publish(kernel.ticket())==(expected=='PASS')
                actual_bytes=sum(map(len,packets))
                predicted_bytes,predicted_calls=episode_cost(trees[name],changed_gates,model)
                assert actual_bytes==predicted_bytes and len(packets)==predicted_calls
                assert all(len(packet)<=model.cap for packet in packets)
                measurements[name]={'bytes':actual_bytes,'refreshes':len(packets),
                                    'max_packet_bytes':max(map(len,packets),default=0),
                                    'verdict':root.verdict,'counts':root.counts}
            rows.append({'seed':seed,'pair':pair,'phase':phase,'changed_modules':changed,
                         'invalidated':changed_gates,'selective':selective,'full_oracle':full,
                         'sources':sources.copy(),'source_hashes':[sha(s) for s in sources],
                         'oracle':expected,'measurements':measurements})
            if idx>=len(previous):
                with journal.open('a') as stream:stream.write(json.dumps(rows[-1],sort_keys=True)+'\n')
    if len(rows)<pairs*2:
        return {'seed':seed,'completed_snapshots':len(rows),'target_snapshots':pairs*2}

    result={'seed':seed,'gates':n,'pairs':pairs,'snapshots':len(rows),'selected_fixed_arity':best,
            'training_invalidations':training,'trees':{name:t.to_dict() for name,t in trees.items()},
            'false_passes':sum(r['oracle']!='PASS' and m['verdict']=='PASS' for r in rows for m in r['measurements'].values()),
            'oracle_disagreements':sum(r['oracle']!=m['verdict'] for r in rows for m in r['measurements'].values()),
            'selective_gate_checks':sum(len(r['selective']) for r in rows),
            'full_oracle_checks':sum(len(r['full_oracle']) for r in rows),
            'methods':{name:{'mean_bytes':float(np.mean([r['measurements'][name]['bytes'] for r in rows])),
                            **stats(t,model)} for name,t in trees.items()}}
    (outdir/f'seed{seed}.json').write_text(json.dumps(result,indent=2)+'\n')
    return result


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--seeds',type=int,default=6);p.add_argument('--seed-start',type=int,default=0)
    p.add_argument('--pairs',type=int,default=16);p.add_argument('--max-new-pairs',type=int,default=None);p.add_argument('--out',type=Path,default=Path('results/executable'))
    args=p.parse_args()
    for seed in range(args.seed_start,args.seed_start+args.seeds):
        r=one(seed,args.out,args.pairs,args.max_new_pairs)
        print(json.dumps({k:v for k,v in r.items() if k not in {'trees','training_invalidations'}}),flush=True)

if __name__=='__main__':main()
