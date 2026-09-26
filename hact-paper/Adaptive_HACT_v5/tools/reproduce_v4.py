#!/usr/bin/env python3
"""Reproduce v4 in a new folder, keeping released observations immutable.
Inputs under results/v3 are historical checker records, not rerun model outputs.
No credentials, provider inference or external deployment are used.
"""
import argparse,os,shutil,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--destination',required=True,type=Path)
    a=p.parse_args();dest=a.destination.resolve()
    if dest.exists() or dest==ROOT or dest.is_relative_to(ROOT):raise ValueError('new destination outside this release required')
    def ignore(directory,names):
        remove={x for x in names if x in {'__pycache__','.pytest_cache','.git'} or x.endswith('.pyc')}
        here=Path(directory)
        if here==ROOT:remove|={'RELEASE_MANIFEST.json'}
        if here==ROOT/'results':remove|={'v4'}
        if here==ROOT/'paper':remove|={'generated_v4'}
        return remove
    shutil.copytree(ROOT,dest,ignore=ignore);(dest/'results/v4').mkdir()
    env=os.environ.copy();env.update(OPENBLAS_NUM_THREADS='1',PYTHONDONTWRITEBYTECODE='1',PYTEST_DISABLE_PLUGIN_AUTOLOAD='1')
    for command in [('-m','experiments_v4.exposure'),('-m','experiments_v4.scaling'),('-m','experiments_v4.online_replay'),('-m','experiments_v4.summarize'),('audit/check_v4.py',),('-m','pytest','-q','-p','pytest_asyncio.plugin')]:
        subprocess.run([sys.executable,*command],cwd=dest,env=env,check=True)
    print('New records:',dest/'results/v4')
if __name__=='__main__':main()
