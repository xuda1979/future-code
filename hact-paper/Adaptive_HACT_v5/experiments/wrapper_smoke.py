"""Integration demonstration with real project tests and full wrapper costs.
Known rejected confirmation candidates are chosen for this functional smoke only;
this is not a randomly sampled performance benchmark or an autonomous repair.
"""
from pathlib import Path
import json,shutil,tempfile
from experiments.runner import ROOT
from experiments.analyze import load
from experiments.benchmarks import SCOPES
from experiments.evaluate_frozen import decode
from ichact.cli import operate

def main():
    reports=[];plans=json.loads((ROOT/'results/plans.json').read_text())
    for project,scope in SCOPES.items():
        base,allr,valid,training,model=load(project)
        oracle=next(r for r in valid if r['mutation']['split']=='confirmation' and r['returncode']==1)
        row=oracle['mutation'];output=ROOT/'results/wrapper'/project;output.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='ichact-wrapper-') as temp:
            source=Path(temp)/'project';shutil.copytree(ROOT/'vendor'/project,source,ignore=shutil.ignore_patterns('__pycache__','*.pyc','.pytest_cache','.future-code','.ai-loop'))
            contract=output/'approved_contract.json'
            good=operate(source,contract,output/'baseline',initialize=True,test_paths=scope['tests'],pythonpath=[scope['pythonpath']])
            old=(source/row['source']).read_bytes();(source/row['source']).write_bytes((ROOT/row['source_file']).read_bytes())
            bad=operate(source,contract,output/'rejected',order=model.order(row['source']),tree=decode(plans[project]['shared']['pooled_frontier']))
            (source/row['source']).write_bytes(old)
            repaired=operate(source,contract,output/'restored',order=model.order(row['source']),tree=decode(plans[project]['shared']['pooled_frontier']))
            assert good['verdict']=='PASS' and bad['verdict']=='FAIL' and repaired['verdict']=='PASS'
            protected=json.loads(contract.read_text())['protected_files'];name=next(n for n in protected if n.endswith('.py'))
            (source/name).write_text('# acceptance input tampered\n')
            rejected=False
            try:operate(source,contract,output/'tampered')
            except ValueError as e:rejected='protected' in str(e)
            assert rejected
            reports.append({'project':project,'known_failing_mutant':row['id'],'baseline':good,'rejected':bad,'restored':repaired,'tampered_acceptance_rejected':rejected})
            print(project,'PASS / FAIL / PASS; tamper rejected',flush=True)
    (ROOT/'results/wrapper_smoke.json').write_text(json.dumps(reports,indent=2))
if __name__=='__main__':main()
