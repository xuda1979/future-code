#!/usr/bin/env python3
"""Independent arithmetic/record audit. No imports of hact/ichact/producers.
This is a second code path, not an external certification or new experiment.
"""
from pathlib import Path
import json,hashlib,math,statistics
from decimal import Decimal,ROUND_FLOOR
from audit.check_v4 import validate_view
ROOT=Path(__file__).resolve().parents[1]

def total_cost(layout,episodes):
    n=len(layout['registry']);order=layout['order'];assert n and len(set(layout['registry']))==n
    assert sorted(order)==list(range(n));nodes=[]
    def walk(t):
        lo,hi=t['lo'],t['hi'];children=t['children'];assert 0<=lo<=hi<n
        if not children:assert lo==hi;return
        assert 2<=len(children)<=8;pos=lo
        for c in children:assert c['lo']==pos;walk(c);pos=c['hi']+1
        assert pos==hi+1
        nodes.append((sum(1<<order[i] for i in range(lo,hi+1)),512+320*len(children)))
    assert layout['tree']['lo']==0 and layout['tree']['hi']==n-1
    walk(layout['tree']);base=sum(v for _,v in nodes);result=0
    for episode in episodes:
        result+=base
        for wave in episode:
            assert len(wave)==len(set(wave)) and all(type(i) is int and 0<=i<n for i in wave)
            mask=sum(1<<i for i in wave)
            result+=sum(price for covered,price in nodes if covered&mask)
    return result

def validate_synthetic(row):
    names=list(row['layouts']);assert names[0]=='incumbent'
    assert len(row['train'])==128 and len(row['validation'])==128 and len(row['heldout'])==256
    assert type(row['fit_seconds']) in (float,int) and 0<=row['fit_seconds']<math.inf
    assert set(row['validation_totals'])==set(names)==set(row['heldout_totals'])
    for name,layout in row['layouts'].items():
        assert len(layout['registry'])==row['n']
        assert total_cost(layout,row['validation'])==row['validation_totals'][name]
        assert total_cost(layout,row['heldout'])==row['heldout_totals'][name]
    assert row['selected']==min(names,key=lambda k:row['validation_totals'][k])

def validate_replay(row,root=ROOT):
    validate_view(row,root)
    ep=root/row['original_evidence'];assert hashlib.sha256(ep.read_bytes()).hexdigest()==row['original_evidence_sha256']
    evidence=json.loads(ep.read_text());assert evidence['registry']==row['layout']['registry']
    indices={g:i for i,g in enumerate(evidence['registry'])}
    waves=[[indices[g] for g in evidence['executed'][i:i+8]] for i in range(0,len(evidence['executed']),8)]
    assert total_cost(row['layout'],[waves])==row['packet_bytes']
    report=json.loads((root/row['source']/'report.json').read_text())
    old=json.loads((ep.parent/'report.json').read_text())
    for field in ('counts','verdict','locally_authorized','snapshot','checker','environment','required'):
        assert report[field]==old[field]
    assert report['pytest_process_seconds'] is None and report['complete_wrapper_seconds'] is None

def validate_planning(rows,replays):
    assert len(rows)==27
    for row in rows:
        a=row['inputs'];mode=row['mode'];assert a['baseline_service']==a['candidate_service']
        pair={}
        for r in replays:
            if r['method'] not in ('fixed8','learned_balanced'):continue
            methods=pair.setdefault((r['project'],r['id']),{})
            assert r['method'] not in methods;methods[r['method']]=r['wire_bytes'][mode]
        assert len(pair)==12 and all(set(p)=={'fixed8','learned_balanced'} for p in pair.values())
        x=sum(p['fixed8'] for p in pair.values());y=sum(p['learned_balanced'] for p in pair.values())
        assert a['baseline_bytes']==x and a['candidate_bytes']==y and x>0 and y>0
        rate=Decimal(str(row['rate']));once=Decimal(str(row['assumed_extra_per_candidate']))*12
        assert Decimal(a['extra_once_seconds'])==once and a['copies']==1 and a['extra_per_copy_seconds']==0
        assert Decimal(str(a['goodput_bytes_per_second']))==rate
        saving=Decimal(x-y)/rate;gain=saving-once
        assert math.isclose(row['per_copy_gain_seconds'],float(saving),abs_tol=1e-12)
        assert math.isclose(row['gain_seconds'],float(gain),abs_tol=1e-12)
        expected=int((once/saving).to_integral_value(rounding=ROUND_FLOOR))+1 if saving>0 else None
        assert row['minimum_profitable_copies']==expected
        assert row['status']==('BENEFICIAL' if gain>0 else 'NOT_BENEFICIAL')

def validate_summary(s,practical,replays):
    comparisons=0
    def eq(a,b):
        nonlocal comparisons
        assert math.isclose(a,b,rel_tol=1e-12,abs_tol=1e-10);comparisons+=1
    assert s['actual_BPE_counts'] is None
    for key,value in [('synthetic_workloads',27),('historical_candidates',12),('layout_replays',36),('new_checker_executions',0),('physical_WAN_trials',0),('hosted_LLM_trials',0)]:eq(s[key],value)
    assert len(s['synthetic'])==9 and len(s['projects'])==3
    for row in s['synthetic']:
        group=[p for p in practical if (p['n'],p['kind'])==(row['n'],row['kind'])];assert len(group)==3
        reductions=[100*(1-p['heldout_totals'][p['selected']]/p['heldout_totals']['incumbent']) for p in group]
        eq(row['seeds'],3);eq(row['heldout_reduction_mean'],sum(reductions)/3)
        eq(row['heldout_reduction_range'][0],min(reductions));eq(row['heldout_reduction_range'][1],max(reductions))
        eq(row['fit_seconds_median'],sorted(p['fit_seconds'] for p in group)[1])
        eq(row['changed'],sum(p['selected']!='incumbent' for p in group))
    for row in s['projects']:
        for method in ('fixed8','learned_balanced','learned_exact'):
            group=[p for p in replays if (p['project'],p['method'])==(row['project'],method)];assert len(group)==4
            for mode in ('padded','compact','packet_zlib','batch_zlib'):eq(row['bytes'][method][mode],sum(p['wire_bytes'][mode] for p in group))
            eq(row['diagnostic_pages'][method],sum(p['diagnostic_pages'] for p in group));eq(row['diagnostic_input_bytes'][method],sum(p['diagnostic_total_input_bytes'] for p in group))
        for mode in ('padded','compact','packet_zlib','batch_zlib'):eq(row['balanced_reduction_percent'][mode],100*(1-row['bytes']['learned_balanced'][mode]/row['bytes']['fixed8'][mode]))
    keys={(p['project'],p['id']) for p in replays}
    assert len(keys)==12
    for key in keys:
        group=[p for p in replays if (p['project'],p['id'])==key]
        assert len(group)==3 and {p['method'] for p in group}=={'fixed8','learned_balanced','learned_exact'}
        assert len({p['root_sha256'] for p in group})==1
    eq(s['root_identical_triples'],12);assert s['root_bytes_range']==[min(p['root_prompt_bytes'] for p in replays),max(p['root_prompt_bytes'] for p in replays)]
    eq(s['max_diagnostic_bytes'],max(p['diagnostic_max_page_bytes'] for p in replays))
    for method in ('fixed8','learned_balanced','learned_exact'):eq(s['diagnostic_pages'][method],sum(p['diagnostic_pages'] for p in replays if p['method']==method))
    return comparisons

def main():
    out=ROOT/'results/v5';p=json.loads((out/'practical.json').read_text());r=json.loads((out/'source_replay.json').read_text())
    assert len(p)==27 and len(r)==36
    keys={(x['n'],x['kind'],x['seed']) for x in p}
    assert keys=={(n,k,s) for n in (128,512,1024) for k in ('cluster','independent','global') for s in (55011,55012,55013)}
    for row in p:validate_synthetic(row)
    for row in r:validate_replay(row)
    validate_planning(json.loads((out/'planning.json').read_text()),r)
    count=validate_summary(json.loads((out/'summary.json').read_text()),p,r)
    for filename in ('bpe_cl100k.json','bpe_o200k.json'):
        b=json.loads((out/filename).read_text());assert b['status']=='UNKNOWN' and b['records'] is None
    result={'status':'PASS','synthetic_workloads':len(p),'archived_candidate_layout_replays':len(r),'planning_scenarios':27,
        'summary_numeric_comparisons':count,'new_checker_runs':0,'physical_WAN_trials':0,'measured_BPE_counts':None,
        'producer_imports':False,'scope':'arithmetic, provenance and serialization, not independent security accreditation'}
    (out/'audit.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
if __name__=='__main__':main()
