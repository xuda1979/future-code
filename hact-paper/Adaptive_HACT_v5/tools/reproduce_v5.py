#!/usr/bin/env python3
"""Rerun frozen v5 layout experiments in a new external folder, no network.
Historical check results and tokenizer-unavailability attempts stay historical.
No model, upload, server or tokenizer fetch is implicit in reproduction.
"""
import argparse,os,shutil,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--destination',required=True,type=Path)
    a=p.parse_args();dest=a.destination.resolve()
    if dest.exists() or dest==ROOT or dest.is_relative_to(ROOT):raise ValueError('new external destination required')
    def ignore(folder,names):
        return [x for x in names if x in {'__pycache__','.pytest_cache','.git','RELEASE_MANIFEST.json'} or x.endswith('.pyc')]
    shutil.copytree(ROOT,dest,ignore=ignore)
    out=dest/'results/v5'
    shutil.rmtree(out/'source_replay')
    for name in ('practical.json','source_replay.json','planning.json','summary.json','audit.json'):(out/name).unlink()
    env={**os.environ,'PYTEST_DISABLE_PLUGIN_AUTOLOAD':'1','PYTHONDONTWRITEBYTECODE':'1','OPENBLAS_NUM_THREADS':'1'}
    commands=[['-m','experiments_v5.practical'],['-m','experiments_v5.source_replay'],['-m','experiments_v5.planning'],['-m','experiments_v5.summarize'],['-m','audit.check_v5'],['-m','pytest','-q','-p','pytest_asyncio.plugin']]
    with (out/'reproduction.log').open('x') as log:
        for cmd in commands:
            print('RUN',*cmd,flush=True);log.write('RUN '+' '.join(cmd)+'\n');log.flush()
            subprocess.run([sys.executable,*cmd],cwd=dest,env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
    print('New layout observations:',out,'; historical checker/BPE records retained, not newly measured')
if __name__=='__main__':main()
