#!/usr/bin/env python3
"""Compile the balanced-only practical catalogue from separate training/validation.
Input JSON: registry, training (epochs of waves of canonical integer IDs), validation.
Output is a layout candidate, not a changed acceptance contract or deployment.
"""
import argparse,json,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from ichact.practical import select_practical

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--input',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    a=p.parse_args()
    if a.output.exists():raise ValueError('output must be new')
    data=json.loads(a.input.read_text());start=time.perf_counter()
    if set(data)!={'registry','training','validation'}:raise ValueError('exact input schema required')
    layout,summary=select_practical(data['registry'],data['training'],data['validation'])
    summary.update(elapsed_seconds=time.perf_counter()-start,automatic_deployment=False)
    a.output.mkdir(parents=True)
    (a.output/'layout.json').write_text(json.dumps(layout.to_dict(),indent=2))
    (a.output/'selection.json').write_text(json.dumps(summary,indent=2))
if __name__=='__main__':main()
