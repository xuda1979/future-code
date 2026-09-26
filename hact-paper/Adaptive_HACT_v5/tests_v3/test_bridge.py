import json,subprocess,sys
from pathlib import Path
import pytest
from ichact.cli import operate
from ichact.layout import Layout
from hact.tree import compact_balanced
def project(tmp_path):
    p=tmp_path/'project';p.mkdir();(p/'calc.py').write_text('def add(a,b):\n    return a+b\n')
    (p/'tests').mkdir();(p/'tests/test_calc.py').write_text('from calc import add\ndef test_positive():\n    assert add(2,3)==5\ndef test_negative():\n    assert add(-2,3)==1\n')
    return p


def test_real_bridge_pass_fail_and_actual_cost(tmp_path):
    p=project(tmp_path);contract=tmp_path/'contract.json'
    operate(p,contract,tmp_path/'baseline',initialize=True)
    registry=tuple(json.loads(contract.read_text())['registry'])
    layout=Layout(registry,(1,0),compact_balanced(2,8));layoutfile=tmp_path/'layout.json';layoutfile.write_text(json.dumps(layout.to_dict()))
    script=Path(__file__).resolve().parents[1]/'ichact/future_bridge.py'
    command=[sys.executable,str(script),'--contract',str(contract),'--reports',str(tmp_path/'reports'),'--layout',str(layoutfile)]
    result=subprocess.run(command,cwd=p,capture_output=True,text=True,timeout=15)
    assert result.returncode==0,result.stdout+result.stderr
    card=json.loads(result.stdout);report=json.loads(Path(card['report']).read_text())
    assert card['verdict']=='PASS' and card['hosted_llm_tokens'] is None
    assert (Path(card['report']).parent/'certificate_packets.bin').stat().st_size==card['packet_bytes']
    assert report['layout_order']==[1,0] and report['aggregation_seconds']>0
    (p/'calc.py').write_text('def add(a,b):\n    return a-b\n')
    result=subprocess.run(command,cwd=p,capture_output=True,text=True,timeout=15)
    assert result.returncode==1 and json.loads(result.stdout)['verdict']=='FAIL'


def test_added_protected_file_rejected(tmp_path):
    p=project(tmp_path);contract=tmp_path/'contract.json'
    operate(p,contract,tmp_path/'baseline',initialize=True)
    (p/'conftest.py').write_text('# newly injected pytest configuration\n')
    with pytest.raises(ValueError,match='protected'):operate(p,contract,tmp_path/'bad')


def test_checker_or_environment_mismatch_rejected(tmp_path):
    p=project(tmp_path);contract=tmp_path/'contract.json'
    operate(p,contract,tmp_path/'baseline',initialize=True)
    c=json.loads(contract.read_text());c['baseline_checker']='0'*64;contract.write_text(json.dumps(c))
    with pytest.raises(ValueError,match='checker'):operate(p,contract,tmp_path/'bad')
