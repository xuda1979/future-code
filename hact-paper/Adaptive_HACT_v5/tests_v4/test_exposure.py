import json,struct,zlib
import pytest
from hact.certificates import Kernel,Gate,canonical
from hact.tree import compact_balanced
from ichact.exposure import *

@pytest.fixture
def packets():
    k=Kernel([Gate(str(i),('x',)) for i in range(9)],{'x':'v'})
    return k.refresh(compact_balanced(9,8))[1]

@pytest.mark.parametrize('mode',list(MODES))
def test_roundtrip(mode,packets):
    w=encode_wire(packets,mode);q=decode_wire(w)
    assert [packet_objects(p) for p in q]==[packet_objects(p) for p in packets]
    assert all(len(p)<=3072 for p in q)
    if mode=='padded':assert q==packets

@pytest.mark.parametrize('kind',['prefix','suffix','truncate','count','rawsize','mode','bomb'])
def test_bad_wire(kind,packets):
    w=encode_wire(packets,'batch_zlib')
    if kind=='prefix':w=b'x'+w[1:]
    elif kind=='suffix':w+=b'x'
    elif kind=='truncate':w=w[:-2]
    elif kind=='count':w=HEADER.pack(MAGIC,3,999,100)+w[HEADER.size:]
    elif kind=='rawsize':w=HEADER.pack(MAGIC,3,3,MAX_ARCHIVE+1)+w[HEADER.size:]
    elif kind=='mode':w=HEADER.pack(MAGIC,99,3,100)+w[HEADER.size:]
    elif kind=='bomb':w=HEADER.pack(MAGIC,3,3,5)+zlib.compress(b'A'*100000)
    with pytest.raises(ValueError):decode_wire(w)

@pytest.mark.parametrize('kind',['count','gap','hash','field','range','card'])
def test_bad_packet(kind,packets):
    rows=packet_objects(packets[0])
    if kind=='count':rows[1]['counts']=[0,0,0]
    elif kind=='gap':rows[1]['range'][0]+=1
    elif kind=='hash':rows[1]['registry']='0'*64
    elif kind=='field':rows[0]['extra']=1
    elif kind=='range':rows[0]['range']=[1,0]
    elif kind=='card':rows=rows[:2]
    with pytest.raises(ValueError):packet_objects(b''.join(canonical(x)+b'\n' for x in rows))

def test_pages_no_truncation_and_budget(packets):
    data=packets*20;pages=diagnostic_pages(data,budget=4000)
    assert all(len(p)<=4000 for p in pages)
    recovered=b''.join(p.split(b'\n',1)[1] for p in pages)
    assert recovered==b''.join(compact_packet(p) for p in data)
    with pytest.raises(ValueError):diagnostic_pages(data,budget=20)
    assert split_packets(b''.join(packets))==packets

@pytest.mark.parametrize('authorized,counts,expected',[(True,[9,0,0],'PASS'),(False,[9,0,0],'UNKNOWN'),(True,[8,1,0],'FAIL'),(True,[8,0,1],'UNKNOWN')])
def test_root_status(authorized,counts,expected):
    r=dict(required=9,counts=counts,locally_authorized=authorized,**{x:'a'*64 for x in ('snapshot','checker','environment','registry_hash')})
    a=status_prompt(r);assert json.loads(a.split(b'\n')[1])['verdict']==expected
    r['layout_id']='b'*64;r['tree']={'different':True};assert status_prompt(r)==a

def test_root_missing_identity():
    with pytest.raises(ValueError):status_prompt({'counts':[2,0,0],'required':2})
