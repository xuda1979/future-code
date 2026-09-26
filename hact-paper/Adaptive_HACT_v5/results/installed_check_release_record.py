from pathlib import Path
import hashlib,json,subprocess,sys,tempfile,os
src=Path('/mnt/data/hact_v3_work/Adaptive_HACT_v3')
installed=Path('/mnt/data/hact_v3_work/install_smoke')
import ichact,hact
from hact.tree import compact_balanced
from hact.certificates import digest
from ichact.layout import Layout
from ichact.adaptive_guard import AdaptiveGuard
checks={}
for package in ('ichact','hact'):
    for f in sorted((src/package).glob('*.py')):
        target=installed/package/f.name
        assert target.read_bytes()==f.read_bytes(),str(f)
        checks[f'{package}/{f.name}']=hashlib.sha256(target.read_bytes()).hexdigest()
assert str(Path(ichact.__file__).resolve()).startswith(str(installed))
r=tuple('g'+str(i) for i in range(16)); tree=compact_balanced(16,8)
a=Layout(r,tuple(range(16)),tree);b=Layout(r,tuple(reversed(range(16))),tree)
g=AdaptiveGuard(r,'snapshot','checker','env',a)
for name in r:g.submit(g.token(name),'PASS',digest(name))
g.refresh();old=g.issue();assert g.authorize(old)
g.migrate(b);assert not g.authorize(old);assert g.authorize(g.issue())
for mod in ('ichact','ichact.future_bridge'):
    p=subprocess.run([sys.executable,'-m',mod,'--help'],capture_output=True,text=True)
    assert p.returncode==0,(mod,p.stderr)
with tempfile.TemporaryDirectory(prefix='hact-installed-') as tmp:
    root=Path(tmp);p=root/'candidate';p.mkdir();(p/'calc.py').write_text('def add(a,b):\n    return a+b\n')
    tests=p/'tests';tests.mkdir();(tests/'test_calc.py').write_text('from calc import add\n\ndef test_add():\n    assert add(2,3)==5\n')
    contract=root/'contract.json'
    proc=subprocess.run([sys.executable,'-m','ichact','init','--project',str(p),'--contract',str(contract),'--output',str(root/'baseline'),'--test-path','tests'],text=True,capture_output=True)
    assert proc.returncode==0,(proc.stdout,proc.stderr)
    bridge=[sys.executable,'-m','ichact.future_bridge','--project',str(p),'--contract',str(contract),'--reports',str(root/'reports')]
    ok=subprocess.run(bridge,text=True,capture_output=True);assert ok.returncode==0,(ok.stdout,ok.stderr)
    (p/'calc.py').write_text('def add(a,b):\n    return a-b\n')
    bad=subprocess.run(bridge,text=True,capture_output=True);assert bad.returncode==1,(bad.stdout,bad.stderr)
    outcomes={'good':json.loads(ok.stdout)['verdict'],'bad':json.loads(bad.stdout)['verdict']}
record={'verdict':'PASS','installed_origin':str(ichact.__file__),'runtime_file_count':len(checks),'runtime_sha256':checks,'checks':['all installed runtime bytes equal released source','stable-ID migration revokes old ticket','both CLI entrypoint help calls','installed complete real pytest bridge acceptance and rejection'],'bridge_outcomes':outcomes,'hosted_llm_evaluated':False}
(src/'results'/'installed_smoke.json').write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(record,indent=2))
