from copy import deepcopy
from pathlib import Path
import json
import pytest
from audit.check_v14 import verify

ROOT=Path(__file__).resolve().parents[1]


def raw():
    return json.loads((ROOT/'results/v14/exchangeable.json').read_text())


def test_independent_current_audit():
    assert verify(raw())['items_wins_vs_fullwave32']==15


@pytest.mark.parametrize('kind',['case','optimum','count','data','negative','exclusion','source'])
def test_corruptions_reject(kind):
    data=deepcopy(raw())
    if kind=='case':data['exhaustive']['cases'].pop()
    elif kind=='optimum':
        r=next(r for r in data['exhaustive']['cases'] if r['width']==r['n']);r['exact_optimum']='1'
    elif kind=='count':data['exhaustive']['global_tree_comparisons']+=1
    elif kind=='data':data['public'][0]['original_runs'][0]['exchangeable']+=1
    elif kind=='negative':
        r=next(r for r in data['public'][0]['dispatch_shifts'] if r['policy']=='files');r['exchangeable']=r['fullwave32']-1
    elif kind=='exclusion':data['public'][2]['status']='PASS'
    elif kind=='source':data['inputs']['ichact/exchangeable.py']='0'*64
    with pytest.raises(ValueError):verify(data)
