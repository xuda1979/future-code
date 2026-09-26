"""New, nonoverlapping intervention sites after a disclosed pilot model choice.
Generate and hash-freeze the plan before running. No replacement by outcome.
"""
from __future__ import annotations
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
from experiments.runner import ROOT
from experiments.benchmarks import SCOPES
from experiments.mutations import candidates, apply_at, run_one
from ichact.identity import source_manifest, canonical, checker_identity, environment_identity


def freeze():
    target = ROOT/'docs/CONFIRMATION_PLAN.json'
    if target.exists():
        raise ValueError('confirmation plan is immutable; refusing overwrite')
    old = json.loads((ROOT/'docs/MUTATION_PLAN.json').read_text()); rows = []
    for project, scope in SCOPES.items():
        for rel in scope['sources']:
            source = (ROOT/'vendor'/project/rel).read_text()
            occupied = [r['span'] for r in old if r['project'] == project and r['source'] == rel]
            options = []
            for node, kind, replacement in candidates(source):
                text, span = apply_at(source, node, replacement)
                if any(max(span[0],a)<min(span[1],b) for a,b in occupied):
                    continue
                try: compile(text, rel, 'exec')
                except SyntaxError: continue
                key = hashlib.sha256(f'20260919:{project}:{rel}:{span}:{kind}'.encode()).hexdigest()
                options.append((key,node,kind,replacement,text,span))
            selected=[]
            for option in sorted(options,key=lambda x:x[0]):
                span=option[-1]
                if any(max(span[0],x[-1][0])<min(span[1],x[-1][1]) for x in selected):continue
                selected.append(option)
                if len(selected)==3:break
            for key,node,kind,replacement,text,span in selected:
                ident=f'{project}_confirm_{len(rows):03d}'
                outfile=ROOT/'results/mutants'/f'{ident}.py';outfile.write_text(text)
                rows.append({'id':ident,'project':project,'source':rel,'line':node.lineno,'kind':kind,'split':'confirmation',
                             'span':span,'replacement':replacement,'base_sha256':hashlib.sha256(source.encode()).hexdigest(),
                             'mutant_sha256':hashlib.sha256(text.encode()).hexdigest(),'source_file':str(outfile.relative_to(ROOT))})
    sources={project:source_manifest(ROOT/'vendor'/project) for project in SCOPES}
    (ROOT/'docs/SNAPSHOT_MANIFESTS.json').write_text(json.dumps(sources,sort_keys=True,indent=2))
    contract={'frozen_utc':datetime.now(timezone.utc).isoformat(),'seed':20260919,
        'reason':'Pilot held-out outcomes were exposed and conditional trees overfit. New sites are a confirmation set, not the original untouched test claim.',
        'decision':'Default certificate tree: pooled training frontiers. Default priority: source-conditioned fault-set cover with complete-registry tail. Conditional-tree variant retained as negative ablation.',
        'training':'Original 45 training mutations only; no pilot held-out outcomes added.',
        'frozen_plans_sha256':hashlib.sha256((ROOT/'results/plans.json').read_bytes()).hexdigest(),
        'frozen_model_code':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (ROOT/'ichact').glob('*.py')},
        'manifest_sha256':canonical(sources),'checker_identity':checker_identity(),'environment_identity':environment_identity(),
        'timing':'First four confirmation IDs per project; three repetitions; default, coverage, conditional. Timeout/incomplete oracle retained as UNKNOWN, omitted from finite paired time differences.',
        'rows':rows}
    target.write_text(json.dumps(contract,indent=2));print('FROZEN',len(rows),dict(Counter(r['project'] for r in rows)),flush=True)

def run():
    contract=json.loads((ROOT/'docs/CONFIRMATION_PLAN.json').read_text())
    assert hashlib.sha256((ROOT/'results/plans.json').read_bytes()).hexdigest()==contract['frozen_plans_sha256']
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures={pool.submit(run_one,row):row for row in contract['rows']}
        for f in as_completed(futures):
            row=futures[f];r=f.result()
            print(row['id'],r['returncode'],'failed',sum(v['status']=='FAIL' for v in r['records'].values()),'executed',len(r['executed']),flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('action',choices=['freeze','run']);a=p.parse_args()
    freeze() if a.action=='freeze' else run()
