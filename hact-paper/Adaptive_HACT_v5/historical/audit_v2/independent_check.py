"""Independent data/traffic audit using only the standard library.
No import from hact, ichact, experiments, or the statistical producer.
"""
from pathlib import Path
import hashlib,json,math,statistics,random
from collections import defaultdict
ROOT=Path(__file__).resolve().parents[1]

def h(data):return hashlib.sha256(data).hexdigest()
def canon(data):return h(json.dumps(data,sort_keys=True,separators=(',',':')).encode())

def nodes(tree):
    yield tree
    for child in tree['children']:yield from nodes(child)

def price(tree,waves,n):
    assert (tree['lo'],tree['hi'])==(0,n-1)
    result=0;max_packet=0
    for node in nodes(tree):
        assert 0<=node['lo']<=node['hi']<n
        children=node['children']
        if not children:
            assert node['lo']==node['hi'];continue
        assert 2<=len(children)<=8
        cursor=node['lo']
        for child in children:
            assert child['lo']==cursor;cursor=child['hi']+1
        assert cursor==node['hi']+1
        packet=512+320*len(children);max_packet=max(max_packet,packet)
        result+=packet  # full initial construction
        for wave in waves:
            if any(node['lo']<=g<=node['hi'] for g in wave):result+=packet
    return result,max_packet

def check_price(tree,waves,n,record):
    total,cap=price(tree,waves,n)
    assert total==record['actual_bytes'] and cap==record['maximum_packet']

def audit_statistics():
    summary=json.loads((ROOT/'results/summary_metrics.json').read_text())['comparisons']
    ep={r['id']:r for r in json.loads((ROOT/'results/frozen_evaluation.json').read_text())['episodes']}
    timing={}
    for phase,file in [('development','timing_summary_raw.json'),('confirmation','confirmation_timing_raw.json')]:
        groups=defaultdict(list)
        for r in json.loads((ROOT/'results'/file).read_text()):groups[(r['id'],r['method'])].append(r['seconds'])
        timing[phase]={k:statistics.median(v) for k,v in groups.items()}
    checked=0
    for key,record in summary.items():
        phase,metric,baseline=key.split('_',2);groups=defaultdict(lambda:defaultdict(list))
        for case in record['cases']:
            e=ep[case['id']];assert e['phase']==phase
            if metric=='time':a=timing[phase][(case['id'],baseline)];b=timing[phase][(case['id'],'conditional')]
            elif metric=='checks':
                assert e['oracle_fail'];a=e['scheduling'][baseline]['tests'];b=e['scheduling']['conditional']['tests']
            else:a=e['certificates'][baseline]['actual_bytes'];b=e['certificates']['pooled_frontier']['actual_bytes']
            assert a==case['baseline'] and b==case['candidate']
            groups[case['project']][case['source']].append((a,b))
        a=sum(c['baseline'] for c in record['cases']);b=sum(c['candidate'] for c in record['cases'])
        assert abs(100*(1-b/a)-record['reduction_pct'])<1e-10
        assert abs(a/len(record['cases'])-record['baseline_mean'])<1e-10
        assert abs(b/len(record['cases'])-record['candidate_mean'])<1e-10
        randomizer=random.Random(record['seed']);values=[]
        for repetition in range(record['bootstrap_repetitions']):
            a=b=0.0
            for project in sorted(groups):
                labels=sorted(groups[project])
                for draw in range(len(labels)):
                    pairs=groups[project][labels[randomizer.randrange(len(labels))]]
                    a+=sum(x[0] for x in pairs);b+=sum(x[1] for x in pairs)
            values.append(100*(1-b/a))
        values.sort()
        for probability,claimed in zip([.025,.975],record['ci_pct']):
            position=(len(values)-1)*probability;low=int(position);fraction=position-low
            actual=values[low]+fraction*(values[min(low+1,len(values)-1)]-values[low])
            assert abs(actual-claimed)<1e-9
        checked+=1
    return checked

def run():
    old=json.loads((ROOT/'docs/MUTATION_PLAN.json').read_text())
    conf=json.loads((ROOT/'docs/CONFIRMATION_PLAN.json').read_text())
    plan=old+conf['rows'];rows={r['id']:r for r in plan}
    assert len(rows)==121 and sum(r['split']=='train' for r in plan)==45
    for i,a in enumerate(plan):
        original=(ROOT/'vendor'/a['project']/a['source']).read_bytes();mutant=(ROOT/a['source_file']).read_bytes()
        assert h(original)==a['base_sha256'] and h(mutant)==a['mutant_sha256']
        lo,hi=a['span'];assert original[:lo]+a['replacement'].encode()+original[hi:]==mutant
        for b in plan[i+1:]:
            if (a['project'],a['source'])==(b['project'],b['source']):
                assert max(lo,b['span'][0])>=min(hi,b['span'][1]),'overlapping mutation sites'
    assert h((ROOT/'results/plans.json').read_bytes())==conf['frozen_plans_sha256']
    plans=json.loads((ROOT/'results/plans.json').read_text());data=json.loads((ROOT/'results/frozen_evaluation.json').read_text())['episodes']
    initial=json.loads((ROOT/'docs/SNAPSHOT_MANIFESTS.json').read_text())
    assert canon(initial)==conf['manifest_sha256']
    for project,manifest in initial.items():
        for rel,expected in manifest.items():assert h((ROOT/'vendor'/project/rel).read_bytes())==expected
    decisions=0
    for ep in data:
        r=json.loads((ROOT/'results/mutations'/f"{ep['id']}.json").read_text());registry=r['registry'];index={g:i for i,g in enumerate(registry)}
        assert len(registry)==ep['registry'] and r['snapshot_after_matches'] and not r['timed_out']
        fails={g for g,v in r['records'].items() if v['status']=='FAIL'};assert bool(fails)==ep['oracle_fail']
        for method,item in ep['scheduling'].items():
            order=item['order'];assert len(order)==len(registry) and set(order)==set(registry)
            executed=[]
            for g in order:
                executed.append(g)
                if g in fails:break
            assert len(executed)==item['tests']
        sequence=ep['scheduling']['conditional']['order'];visited=[]
        for g in sequence:
            visited.append(index[g])
            if g in fails:break
        waves=[visited[i:i+8] for i in range(0,len(visited),8)]
        assert waves==ep['waves']
        manifest=dict(initial[ep['project']]);manifest[ep['source']]=rows[ep['id']]['mutant_sha256']
        for method,record in ep['certificates'].items():
            tree=(plans[ep['project']]['conditional'][ep['source']] if method=='conditional_frontier' else plans[ep['project']]['shared'][method])
            check_price(tree,waves,len(registry),record)
            assert record['snapshot_identity']==canon(manifest)
            assert record['verdict']==('FAIL' if fails else 'PASS')
            assert sum(record['counts'])==len(registry) and record['maximum_packet']<=3072
            decisions+=1
    timing={}
    for name in ['timing_summary_raw.json','confirmation_timing_raw.json']:
        path=ROOT/'results'/name
        if not path.exists():continue
        data=json.loads(path.read_text());seen=set()
        for rec in data:
            key=(rec['id'],rec['method'],rec['repeat']);assert key not in seen;seen.add(key)
            assert rec['same_verdict'] and not rec['timeout'] and math.isfinite(rec['seconds']) and rec['seconds']>0
            raw=json.loads((ROOT/'results/timing'/f"{rec['id']}_{rec['method']}_{rec['repeat']}.json").read_text())
            assert raw['returncode']==rec['actual_code']==rec['oracle_code']
            assert abs(rec['seconds']-(raw['end_to_end_seconds']+rec['order_planning_seconds']))<1e-8
            assert rec['executed']==len(raw['executed']) and raw['snapshot_after_matches']
        timing[name]={'runs':len(data),'verdict_mismatches':0}
    # A deliberately damaged packet total must be caught by this independent path.
    example=json.loads((ROOT/'results/frozen_evaluation.json').read_text())['episodes'][0]
    tree=plans[example['project']]['shared']['pooled_frontier'];correct,_=price(tree,example['waves'],example['registry'])
    damaged=dict(example['certificates']['pooled_frontier']);damaged['actual_bytes']+=1
    detected=False
    try:check_price(tree,example['waves'],example['registry'],damaged)
    except AssertionError:detected=True
    assert detected
    statistics_checked=audit_statistics()
    output={'status':'PASS','mutation_sites':len(plan),'disjoint_sites':True,'packet_decisions':decisions,
            'maximum_packet_cap':3072,'paired_comparisons_recomputed':statistics_checked,'timing':timing,'producer_imported':False,'tampered_total_detected':True}
    (ROOT/'results/independent_audit.json').write_text(json.dumps(output,indent=2));print(json.dumps(output,indent=2))
if __name__=='__main__':run()
