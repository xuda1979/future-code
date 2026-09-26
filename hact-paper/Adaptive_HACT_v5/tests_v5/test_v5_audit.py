"""Tamper tests for an independent audit path; no producer cost helpers."""
import copy,json
from pathlib import Path
import pytest
from audit.check_v5 import validate_synthetic,validate_planning,validate_replay,validate_summary
ROOT=Path(__file__).resolve().parents[1]
@pytest.fixture(scope='module')
def data():
    r=ROOT/'results/v5'
    return {k:json.loads((r/(k+'.json')).read_text()) for k in ('practical','source_replay','planning','summary')}
def test_reference_small_cost(data):validate_synthetic(data['practical'][0])
def test_cost_tamper(data):
    x=copy.deepcopy(data['practical'][0]);x['heldout_totals']['incumbent']+=1
    with pytest.raises(AssertionError):validate_synthetic(x)
def test_selection_tamper(data):
    x=copy.deepcopy(data['practical'][0]);x['selected']='incumbent'
    with pytest.raises(AssertionError):validate_synthetic(x)
def test_no_empty_group_planning(data):
    r=copy.deepcopy(data['source_replay'])
    for x in r:
        if x['method']=='learned_balanced':x['method']='typo'
    with pytest.raises(AssertionError):validate_planning(data['planning'],r)
def test_missing_cost_never_zero(data):
    p=copy.deepcopy(data['planning']);p[0]['inputs']['candidate_bytes']=0
    with pytest.raises(AssertionError):validate_planning(p,data['source_replay'])
def test_copy_break_even_tamper(data):
    p=copy.deepcopy(data['planning']);p[0]['minimum_profitable_copies']+=1
    with pytest.raises(AssertionError):validate_planning(p,data['source_replay'])
def test_provenance_tamper(data):
    r=copy.deepcopy(data['source_replay'][0]);r['original_evidence_sha256']='0'*64
    with pytest.raises(AssertionError):validate_replay(r)
def test_false_empirical_wan(data):
    s=copy.deepcopy(data['summary']);s['physical_WAN_trials']=1
    with pytest.raises(AssertionError):validate_summary(s,data['practical'],data['source_replay'])
def test_false_BPE(data):
    s=copy.deepcopy(data['summary']);s['actual_BPE_counts']=123
    with pytest.raises(AssertionError):validate_summary(s,data['practical'],data['source_replay'])
