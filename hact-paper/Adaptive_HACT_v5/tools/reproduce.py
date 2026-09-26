#!/usr/bin/env python3
"""Run v3 experiments in a NEW destination, preserving released evidence.

No hosted inference, credentials, or external deployment is used. A full campaign
runs local mutation checks, transient-fault fixtures and deterministic simulations.
"""
from __future__ import annotations
import argparse,os,shutil,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]


def prepare(destination:Path):
    destination=destination.resolve()
    if destination==ROOT or destination.is_relative_to(ROOT):raise ValueError('destination must be outside released source')
    if destination.exists():raise ValueError('destination must not already exist')
    exclude={'results','.git','__pycache__','.pytest_cache','.ai-loop','MANIFEST.json','RELEASE_MANIFEST.json'}
    def ignore(directory,names):
        ignored={n for n in names if n in {'__pycache__','.pytest_cache','.git'} or n.endswith('.pyc')}
        if Path(directory)==ROOT:ignored|=set(names)&exclude
        return ignored
    shutil.copytree(ROOT,destination,ignore=ignore)
    (destination/'results').mkdir()
    (destination/'results/v3').mkdir()
    for p in (destination/'paper/generated').glob('*.tex'):p.unlink()
    return destination


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--destination',type=Path,required=True)
    p.add_argument('--tier',choices=['harness','full'],default='harness');p.add_argument('--repetitions',type=int,default=3)
    args=p.parse_args()
    if args.repetitions<1:raise ValueError('positive repetitions required')
    if args.tier=='full' and args.repetitions!=3:raise ValueError('full audit requires the frozen three-repetition cohort')
    dest=prepare(args.destination);env=os.environ.copy();env.update(OPENBLAS_NUM_THREADS='1',PYTHONDONTWRITEBYTECODE='1')
    def run(*argv):
        print('+',*argv,flush=True);subprocess.run([sys.executable,*argv],cwd=dest,env=env,check=True)
    if args.tier=='full':
        for mode in ('ordering','online','scaling'):run('-m','experiments_v3.bench',mode)
        run('-m','experiments_v3.real_sources','replay');run('-m','experiments_v3.real_sources','run')
    run('-m','experiments_v3.harness','--repetitions',str(args.repetitions))
    if args.tier=='full':
        run('-m','experiments_v3.summarize');run('audit/check_v3.py');run('-m','experiments_v3.figures')
    print('Fresh evidence directory:',dest/'results/v3')
if __name__=='__main__':main()
