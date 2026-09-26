"""The independent auditor must detect falsified structures and measurements."""
import copy
import importlib.util
from pathlib import Path
import pytest
from hact.tree import compact_balanced
from ichact.layout import Layout
P=Path(__file__).resolve().parents[1]/'audit/check_v3.py'
spec=importlib.util.spec_from_file_location('independent_v3_auditor',P)
audit=importlib.util.module_from_spec(spec);spec.loader.exec_module(audit)


def plan():return Layout(tuple('abcd'),(0,1,2,3),compact_balanced(4,2)).to_dict()


def test_independent_cost_known():
    p=plan()
    assert audit.traffic(p,[[[0],[3]]])==[7*1152]


def test_auditor_rejects_duplicate_coverage():
    p=plan();p['order']=[0,0,2,3]
    with pytest.raises(AssertionError,match='permutation'):audit.decode(p)


def test_auditor_rejects_gap():
    p=plan();p['tree']['children'][1]['lo']=3
    with pytest.raises(AssertionError):audit.decode(p)


def test_auditor_rejects_false_cost_model():
    p=plan();p['model']['header']=0
    with pytest.raises(AssertionError,match='packet model'):audit.decode(p)


def test_auditor_rejects_foreign_wave():
    with pytest.raises(AssertionError,match='wave'):audit.traffic(plan(),[[[5]]])
