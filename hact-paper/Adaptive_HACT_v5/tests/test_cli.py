from pathlib import Path
import json
import pytest
from ichact.cli import operate
from ichact.identity import source_manifest


def project(tmp_path):
    p=tmp_path/'project';p.mkdir();(p/'calc.py').write_text('def add(a,b):\n    return a+b\n')
    (p/'tests').mkdir();(p/'tests/test_calc.py').write_text('from calc import add\ndef test_positive():\n    assert add(2,3)==5\ndef test_negative():\n    assert add(-2,3)==1\n')
    return p

def test_real_baseline_mutation_repair(tmp_path):
    p=project(tmp_path);contract=tmp_path/'contract.json'
    baseline=operate(p,contract,tmp_path/'baseline',initialize=True)
    assert baseline['verdict']=='PASS' and baseline['executed']==2
    original=(p/'calc.py').read_text();(p/'calc.py').write_text(original.replace('a+b','a-b'))
    bad=operate(p,contract,tmp_path/'bad');assert bad['verdict']=='FAIL' and not bad['locally_authorized']
    (p/'calc.py').write_text(original)
    good=operate(p,contract,tmp_path/'good');assert good['verdict']=='PASS' and good['locally_authorized']
    assert good['largest_packet_bytes']<=3072
    assert (tmp_path/'good/certificate_packets.bin').stat().st_size==good['packet_bytes']
    (p/'tests/test_calc.py').write_text('def test_positive():\n    pass\n')
    with pytest.raises(ValueError,match='protected'):operate(p,contract,tmp_path/'tampered')

def test_reject_contract_inside_write_scope(tmp_path):
    p=project(tmp_path)
    with pytest.raises(ValueError):operate(p,p/'contract.json',tmp_path/'report',initialize=True)

def test_reject_symlink(tmp_path):
    p=project(tmp_path);(p/'link').symlink_to(tmp_path/'outside')
    with pytest.raises(ValueError,match='symbolic'):source_manifest(p)

def test_nonpermutation_cannot_pass(tmp_path):
    p=project(tmp_path);contract=tmp_path/'contract.json'
    operate(p,contract,tmp_path/'baseline',initialize=True)
    one=json.loads(contract.read_text())['registry'][:1]
    r=operate(p,contract,tmp_path/'badorder',order=one)
    assert r['verdict']=='UNKNOWN' and not r['locally_authorized']

def test_side_effects_revoke_pass(tmp_path):
    p=project(tmp_path);contract=tmp_path/'contract.json'
    operate(p,contract,tmp_path/'baseline',initialize=True)
    (p/'calc.py').write_text("from pathlib import Path\nPath('side_effect.txt').write_text('created')\ndef add(a,b):\n    return a+b\n")
    r=operate(p,contract,tmp_path/'changed')
    assert r['verdict']=='UNKNOWN' and not r['snapshot_unchanged']
