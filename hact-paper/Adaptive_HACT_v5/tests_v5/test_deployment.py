import pytest
from ichact.deployment import assess_delivery

BASE=dict(baseline_bytes=300,candidate_bytes=100,goodput_bytes_per_second=100,
          copies=1,extra_once_seconds=2,baseline_service='contract:A/full-epoch',candidate_service='contract:A/full-epoch')

def run(**k):return assess_delivery(**(BASE|k))

def test_boundary_strict_and_minimal():
    r=run();assert r.gain_seconds==0 and r.status=='NOT_BENEFICIAL' and r.minimum_profitable_copies==2
    assert run(copies=2).status=='BENEFICIAL'

def test_no_savings_no_positive_break_even():
    assert run(candidate_bytes=300).minimum_profitable_copies is None
    assert run(candidate_bytes=400,copies=100).status=='NOT_BENEFICIAL'

def test_missing_is_unknown_not_zero():
    assert run(extra_once_seconds=None).status=='UNKNOWN'
    assert run(goodput_bytes_per_second=None).gain_seconds is None

def test_service_mismatch_not_arithmetic():
    assert run(candidate_service='root-only').status=='INCOMPARABLE'

def test_incremental_per_copy_cost():
    assert run(extra_per_copy_seconds=3,copies=20).status=='NOT_BENEFICIAL'
    assert run(extra_once_seconds=0).minimum_profitable_copies==1

def test_decimal_exact_boundary():
    assert run(baseline_bytes=3,candidate_bytes=0,goodput_bytes_per_second=10,extra_once_seconds=.3).gain_seconds==0

@pytest.mark.parametrize('key,value', [('copies',True),('copies',-1),('baseline_bytes',1.5),('candidate_bytes',-1),('goodput_bytes_per_second',0),('goodput_bytes_per_second',float('nan')),('extra_once_seconds',float('inf')),('extra_per_copy_seconds',-1),('extra_once_seconds',True),('baseline_service','')])
def test_bad_values(key,value):
    with pytest.raises(ValueError):run(**{key:value})
