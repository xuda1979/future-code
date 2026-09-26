#!/usr/bin/env python3
"""Independent reconstruction; imports no ichact/hact optimizer or codec.
This is an independent code path, not an external security certification.
"""
from pathlib import Path
import hashlib,json,struct,zlib,math,statistics
from collections import Counter
ROOT=Path(__file__).resolve().parents[1]

def canon(o):return json.dumps(o,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode('ascii')

def validate_view(row,root=ROOT):
    path=root/row['source'];blob=(path/'certificate_packets.bin').read_bytes()
    assert hashlib.sha256(blob).hexdigest()==row['source_sha256']
    packets=[];current=[]
    for line in blob.splitlines(keepends=True):
        obj=json.loads(line)
        if obj.get('schema')=='hact-1':
            if current:packets.append(current)
            current=[]
        current.append((line,obj))
    if current:packets.append(current)
    assert len(blob)==row['packet_bytes'] and len(packets)==row['packet_count']
    padded=[b''.join(x[0] for x in p) for p in packets]
    compact=[b''.join(canon(x[1])+b'\n' for x in p) for p in packets]
    for p in packets:
        h=p[0][1];cursor=h['range'][0]
        for _,card in p[1:]:
            assert card['range'][0]==cursor and card['registry']==h['registry']
            assert sum(card['counts'])==card['range'][1]-card['range'][0]+1
            cursor=card['range'][1]+1
        assert cursor==h['range'][1]+1
    for code,mode in enumerate(('padded','compact','packet_zlib','batch_zlib')):
        values=padded if mode=='padded' else compact
        rawsize=sum(4+len(v) for v in values)
        enc=[zlib.compress(v,6) if mode=='packet_zlib' else v for v in values]
        frames=b''.join(len(v).to_bytes(4,'big')+v for v in enc)
        if mode=='batch_zlib':frames=zlib.compress(frames,6)
        wire=struct.pack('!8sBII',b'HACTV4\r\n',code,len(values),rawsize)+frames
        assert row['wire_bytes'][mode]==len(wire)+40
    prefix=b'DIAGNOSTIC EVIDENCE. Counts are recorded facts, not a new authorization. Do not infer missing results.\n'
    sizes=[];size=len(prefix)
    for v in compact:
        assert len(prefix)+len(v)<=16384
        if size+len(v)>16384:sizes.append(size);size=len(prefix)
        size+=len(v)
    sizes.append(size)
    assert len(sizes)==row['diagnostic_pages'] and sum(sizes)==row['diagnostic_total_input_bytes'] and max(sizes)==row['diagnostic_max_page_bytes']
    status=row['root_prompt'].encode();assert len(status)==row['root_prompt_bytes'] and hashlib.sha256(status).hexdigest()==row['root_sha256']
    card=json.loads(status.splitlines()[1]);report=json.loads((path/'report.json').read_text())
    for key in ('snapshot','checker','environment','registry_hash','required','counts'):assert card[key]==report[key]
    v='FAIL' if card['counts'][1] else ('PASS' if card['counts']==[card['required'],0,0] and report['locally_authorized'] else 'UNKNOWN')
    assert card['verdict']==v and row['root_prompt_tokens'] is None
    return row


def layout_cost(layout,episodes):
    order=layout['order'];assert sorted(order)==list(range(len(layout['registry'])))
    nodes=[]
    def visit(t):
        children=t['children'];lo,hi=t['lo'],t['hi']
        if not children:assert lo==hi;return
        assert 2<=len(children)<=8
        cur=lo
        for c in children:assert c['lo']==cur;visit(c);cur=c['hi']+1
        assert cur==hi+1
        nodes.append((set(order[lo:hi+1]),512+320*len(children)))
    visit(layout['tree']);base=sum(price for _,price in nodes)
    return sum(base+sum(price for wave in ep for covered,price in nodes if covered.intersection(wave)) for ep in episodes)/len(episodes)


def validate_summary(summary, exp, rows, scales):
    """Recompute published summaries, without importing their producer."""
    checked=0
    def eq(actual, expected):
        nonlocal checked
        assert actual is not None and math.isclose(actual,expected,rel_tol=1e-12,abs_tol=1e-9)
        checked+=1
    assert summary['tokenizer_counts'] is None and summary['provider_usage'] is None
    assert summary['root_prompt_bytes_range']==[min(x['root_prompt_bytes'] for x in exp),max(x['root_prompt_bytes'] for x in exp)]
    eq(summary['max_diagnostic_bytes'],max(x['diagnostic_max_page_bytes'] for x in exp))
    eq(summary['max_local_packet_bytes'],max(x['max_single_compact_packet_bytes'] for x in exp))
    eq(summary['root_identical_pairs'],12)
    assert len(summary['projects'])==3 and len(summary['timing'])==6 and len(summary['scaling'])==6
    for r in summary['projects']:
        groups=[[x for x in exp if x['project']==r['project'] and (x['method']=='fixed8')==fixed] for fixed in (True,False)]
        assert all(len(g)==4 for g in groups)
        for mode in ('padded','compact','packet_zlib','batch_zlib'):
            a,b=[sum(x['wire_bytes'][mode] for x in g) for g in groups]
            eq(r['bytes'][mode]['fixed'],a);eq(r['bytes'][mode]['learned'],b)
            eq(r['wire_reduction_percent'][mode],100*(1-b/a))
        for field in ('diagnostic_pages','diagnostic_total_input_bytes','flat_status_ledger_bytes','flat_status_ledger_zlib_bytes'):
            for name,g in zip(('fixed','learned'),groups):eq(r[field][name],sum(x[field] for x in g))
    for r in summary['timing']:
        groups=[[x for x in rows if x['mode']==r['mode'] and x['rate_bytes_per_second']==r['rate_bytes_per_second'] and (x['method']=='fixed8')==fixed] for fixed in (True,False)]
        assert all(len(g)==24 for g in groups)
        a,b=[sum(x['total_export_seconds'] for x in g)/2 for g in groups]
        eq(r['fixed_seconds_per_12_exports'],a);eq(r['learned_seconds_per_12_exports'],b)
        eq(r['reduction_percent'],100*(1-b/a));eq(r['trials'],48)
        for name,g in zip(('fixed','learned'),groups):eq(r[name+'_encode_seconds'],sum(x['encoding_seconds'] for x in g)/2)
    for r in summary['scaling']:
        g=[x for x in scales if x['n']==r['n'] and x['kind']==r['kind']];assert len(g)==3
        eq(r['order_seconds_median'],statistics.median(x['order_seconds'] for x in g))
        eq(r['blocked_seconds_median'],statistics.median(x['blocked_fit_seconds'] for x in g))
        eq(r['heldout_vs_fixed8_learned_percent'],statistics.mean(100*(x['heldout_cost']['blocked32']/x['heldout_cost']['fixed8_learned']-1) for x in g))
        if g[0]['exact_fit_seconds'] is None:
            assert r['exact_seconds_median'] is None and r['heldout_penalty_vs_exact_percent'] is None
        else:
            eq(r['exact_seconds_median'],statistics.median(x['exact_fit_seconds'] for x in g))
            eq(r['heldout_penalty_vs_exact_percent'],statistics.mean(100*(x['heldout_cost']['blocked32']/x['heldout_cost']['exact']-1) for x in g))
    return checked


def main():
    out=ROOT/'results/v4';exp=json.loads((out/'exposure.json').read_text());assert len(exp)==24
    keyed={}
    for r in exp:validate_view(r);keyed[r['project'],r['id'],r['method']]=r
    pairs={}
    for r in exp:pairs.setdefault((r['project'],r['id']),[]).append(r)
    assert len(pairs)==12 and all(len(v)==2 and v[0]['root_sha256']==v[1]['root_sha256'] for v in pairs.values())
    rows=[json.loads(s) for s in (out/'transport.jsonl').read_text().splitlines()];assert len(rows)==288
    seen=set()
    for r in rows:
        key=(r['project'],r['id'],r['method']);e=keyed[key]
        trial=(*key,r['mode'],r['rate_bytes_per_second'],r['repeat']);assert trial not in seen;seen.add(trial)
        assert r['mode'] in ('compact','batch_zlib') and r['rate_bytes_per_second'] in (65536,1048576,None) and r['repeat'] in (0,1)
        assert r['application_bytes']==e['wire_bytes'][r['mode']] and r['decoded_packets']==e['packet_count'] and r['digest_verified'] is True
        assert math.isclose(r['total_export_seconds'],r['encoding_seconds']+r['socket_roundtrip_seconds'],abs_tol=1e-9)
        if r['rate_bytes_per_second']:assert r['paced_receive_seconds']+0.002>=(r['application_bytes']-40)/r['rate_bytes_per_second']
    scales=json.loads((out/'scaling.json').read_text());assert len(scales)==18
    for s in scales:
        for method,l in s['layouts'].items():
            assert math.isclose(layout_cost(l,s['training']),s['train_cost'][method],abs_tol=1e-7)
            assert math.isclose(layout_cost(l,s['heldout']),s['heldout_cost'][method],abs_tol=1e-7)
        if 'exact' in s['train_cost']:assert s['train_cost']['blocked32']+1e-7>=s['train_cost']['exact']
    replay=json.loads((out/'online_replay.json').read_text());assert len(replay)==80
    for r in replay:
        old=json.loads((ROOT/'results/v3/online'/r['source']).read_text());ref=old['summary']['methods']['window_priced']
        assert r['actions_match'] and r['checkpoint_roundtrip'] and r['events']==len(old['costs'])
        assert r['service_bytes']==ref['service_bytes'] and r['switch_bytes']==ref['switch_bytes']
    checks=validate_summary(json.loads((out/'summary.json').read_text()),exp,rows,scales)
    result={'summary_numeric_comparisons':checks,'status':'PASS','archived_streams':len(exp),'new_tcp_transfers':len(rows),'identical_root_pairs':len(pairs),
            'new_compiler_workloads':len(scales),'old_online_streams_replayed':len(replay),'production_imports':False,
            'limits':'Plaintext/digest validation, not security against replacement of trusted source or reference data.'}
    (out/'audit.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
if __name__=='__main__':main()
