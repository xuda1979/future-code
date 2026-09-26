"""Outcome-blind, site-disjoint mutation campaign over retained real code.
Training and test slots are assigned before any mutated program is executed.
"""
from __future__ import annotations
import ast
from concurrent.futures import ThreadPoolExecutor, as_completed
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
from experiments.benchmarks import SCOPES
from experiments.runner import ROOT, execute

SEED=20260918

def candidates(source):
    root=ast.parse(source)
    for node in ast.walk(root):
        changed=copy.deepcopy(node); kind=None
        if isinstance(node,ast.Compare) and len(node.ops)==1:
            swaps={ast.Eq:ast.NotEq,ast.NotEq:ast.Eq,ast.Lt:ast.LtE,ast.LtE:ast.Lt,ast.Gt:ast.GtE,ast.GtE:ast.Gt}
            if type(node.ops[0]) in swaps:
                changed.ops=[swaps[type(node.ops[0])]()];kind='relational_boundary'
        elif isinstance(node,ast.Constant) and type(node.value) is bool:
            changed.value=not node.value;kind='boolean_flip'
        elif isinstance(node,ast.BinOp) and isinstance(node.op,(ast.Add,ast.Sub,ast.Mult)):
            changed.op=ast.Sub() if isinstance(node.op,ast.Add) else ast.Add();kind='arithmetic_replacement'
        elif isinstance(node,ast.UnaryOp) and isinstance(node.op,ast.Not):
            changed=copy.deepcopy(node.operand);kind='not_removal'
        if kind:
            yield node,kind,'('+ast.unparse(changed)+')'

def apply_at(source,node,replacement):
    raw=source.encode(); lines=raw.splitlines(keepends=True)
    start=sum(map(len,lines[:node.lineno-1]))+node.col_offset
    end=sum(map(len,lines[:node.end_lineno-1]))+node.end_col_offset
    return (raw[:start]+replacement.encode()+raw[end:]).decode(),(start,end)

def plan():
    rows=[]
    for project,scope in SCOPES.items():
        for rel in scope['sources']:
            path=ROOT/'vendor'/project/rel; source=path.read_text()
            options=[]
            for node,kind,replacement in candidates(source):
                text,span=apply_at(source,node,replacement)
                try: compile(text,str(path),'exec')
                except SyntaxError: continue
                identity=f'{SEED}:{project}:{rel}:{span[0]}:{span[1]}:{kind}'
                options.append((hashlib.sha256(identity.encode()).hexdigest(),node,kind,replacement,text,span))
            options.sort(key=lambda x:x[0]); selected=[]
            for o in options:
                # Exclude overlapping/nested mutation sites across train and test.
                if any(max(o[-1][0],v[-1][0])<min(o[-1][1],v[-1][1]) for v in selected):continue
                selected.append(o)
                if len(selected)==6:break
            for i,(key,node,kind,replacement,text,span) in enumerate(selected):
                ident=f'{project}_{len(rows):03d}'
                target=ROOT/'results/mutants'/f'{ident}.py';target.parent.mkdir(parents=True,exist_ok=True);target.write_text(text)
                rows.append({'id':ident,'project':project,'source':rel,'line':node.lineno,'kind':kind,
                             'split':'train' if i%2==0 else 'test','span':span,'replacement':replacement,
                             'base_sha256':hashlib.sha256(source.encode()).hexdigest(),
                             'mutant_sha256':hashlib.sha256(text.encode()).hexdigest(),'source_file':str(target.relative_to(ROOT))})
    (ROOT/'docs/MUTATION_PLAN.json').write_text(json.dumps(rows,indent=2))
    print('Frozen',len(rows),'mutants;',sum(r['split']=='train' for r in rows),'train;',sum(r['split']=='test' for r in rows),'test',flush=True)
    return rows

def run_one(row,mode='full',order=None,repeat=None):
    name=row['id'] if repeat is None else f"{row['id']}_{mode}_{repeat}"
    out=ROOT/'results'/('mutations' if mode=='full' else 'timing')/f'{name}.json'
    with tempfile.TemporaryDirectory(prefix='ichact-',dir=ROOT.parent) as work:
        snapshot=Path(work)/'project'
        shutil.copytree(ROOT/'vendor'/row['project'],snapshot,ignore=shutil.ignore_patterns('__pycache__','*.pyc','.pytest_cache','.future-code'))
        (snapshot/row['source']).write_bytes((ROOT/row['source_file']).read_bytes())
        r=execute(row['project'],snapshot,out,order=order,failfast=(mode!='full'),timeout=30)
        r['mutation']=row
        r['mutant_sha256_observed']=hashlib.sha256((snapshot/row['source']).read_bytes()).hexdigest()
        r['snapshot_after_matches']=r['mutant_sha256_observed']==row['mutant_sha256']
        out.write_text(json.dumps(r,sort_keys=True,indent=2))
        return r

def main():
    rows=plan()
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures={pool.submit(run_one,row):row for row in rows}
        for future in as_completed(futures):
            row=futures[future];r=future.result()
            failed=sum(x.get('status')=='FAIL' for x in r['records'].values())
            print(row['id'],row['split'],r['returncode'],'failures',failed,'executed',len(r['executed']),round(r['end_to_end_seconds'],2),flush=True)
if __name__=='__main__':main()
