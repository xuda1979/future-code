"""Independent arithmetic/serialization audit; imports NO hact/ichact producers.

Verifies stored records, not natural-language claims, hosted inference or checker
adequacy. Fails on missing cohorts rather than interpreting them as zero cost.
"""
from __future__ import annotations
import hashlib,json,math
from pathlib import Path
import numpy as np
ROOT=Path(__file__).resolve().parents[1]


def canonical(x):return json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode('ascii')
def load(path):return json.loads(path.read_text())
def expect(condition,message):
    if not condition:raise AssertionError(message)


def decode(layout):
    registry=layout['registry'];order=layout['order'];n=len(registry);model=layout['model']
    expect(n>0 and len(set(registry))==n,'unique registry')
    expect(all(type(i) is int for i in order) and sorted(order)==list(range(n)),'exact permutation')
    expect(model=={'header':512,'card':320,'cap':3072},'declared packet model')
    cov=[]
    def walk(node,lo,hi):
        expect(node['lo']==lo and node['hi']==hi and 0<=lo<=hi<n,'exact node interval')
        children=node['children']
        if lo==hi:expect(not children,'leaf arity');return
        expect(2<=len(children)<=8,'bounded nonunary arity')
        cursor=lo
        for child in children:
            expect(child['lo']==cursor,'child partition gap/overlap')
            walk(child,cursor,child['hi']);cursor=child['hi']+1
        expect(cursor==hi+1,'full child coverage')
        cov.append((sum(1<<order[j] for j in range(lo,hi+1)),512+320*len(children)))
    walk(layout['tree'],0,n-1)
    return cov


def traffic(layout,episodes,initial=True):
    cover=decode(layout);n=len(layout['registry']);totals=[]
    for episode in episodes:
        total=sum(price for _,price in cover) if initial else 0
        for wave in episode:
            expect(all(type(i)is int and 0<=i<n for i in wave),'invalid wave ID')
            mask=sum(1<<i for i in set(wave))
            for mask2,price in cover:
                if mask&mask2:total+=price
        totals.append(total)
    return totals


def check_packets(path,report):
    if not path.exists():raise AssertionError('missing packet stream')
    lines=path.read_bytes().splitlines(keepends=True);packets=[];current=[]
    for line in lines:
        expect(len(line) in (512,320),'fixed wire width')
        obj=json.loads(line)
        if len(line)==512:
            if current:packets.append(current)
            expect(obj['schema']=='hact-1','packet schema');current=[obj]
        else:
            expect(bool(current),'card without header');current.append(obj)
    if current:packets.append(current)
    sizes=[]
    for p in packets:
        expect(2<=len(p)-1<=8,'packet arity');cursor=p[0]['range'][0]
        for c in p[1:]:
            expect(c['range'][0]==cursor,'wire child coverage');cursor=c['range'][1]+1
            expect(sum(c['counts'])==c['range'][1]-c['range'][0]+1,'wire coverage count')
            expect(all(type(v)is int and v>=0 for v in c['counts']),'nonnegative counts')
            expect(c['registry']==p[0]['registry'],'wire registry coherence')
        expect(cursor==p[0]['range'][1]+1,'wire full interval')
        sizes.append(512+320*(len(p)-1))
    expect(sum(sizes)==path.stat().st_size==report['packet_bytes'],'actual serialized bytes')
    expect(len(sizes)==report['packet_count'] and max(sizes,default=0)==report['largest_packet_bytes']<=3072,'packet summary')
    return len(packets)


def ci(values):
    a=np.array(values);rng=np.random.default_rng(94001)
    means=a[rng.integers(len(a),size=(10000,len(a)))].mean(axis=1)
    return float(a.mean()),*map(float,np.quantile(means,[.025,.975]))


def audit(root=ROOT):
    out=root/'results/v3';counts={'ordering_workloads':0,'online_streams':0,'online_events':0,'replayed_source_cases':0,'fresh_paired_runs':0,'packet_streams':0,'packets':0,'harness_episodes':0,'statistics_verified':0}
    ordering=[]
    for path in sorted((out/'ordering').glob('*.json')):
        x=load(path);s=x['summary'];layouts=x['layouts']
        val={k:sum(traffic(l,x['validation']))/len(x['validation']) for k,l in layouts.items() if k!='fixed8'}
        # Candidate dictionary insertion order is original/spectral/cluster.
        choice=min(val,key=val.get)
        expect(choice==s['selected'],'validation-only selection')
        for k,l in layouts.items():
            expect(sum(traffic(l,x['test']))==s['total_bytes'][k],'held-out aggregation total')
            expect(sum(traffic(l,x['test'],False))==s['incremental_bytes'][k],'incremental total')
        expect(s['total_bytes']['selected']==s['total_bytes'][choice],'selected total')
        counts['ordering_workloads']+=1;ordering.append(s)
    expect(counts['ordering_workloads']==80,'complete ordering cohort')
    online=[]
    for path in sorted((out/'online').glob('*.json')):
        x=load(path);s=x['summary'];layouts=x['layouts'];k=len(layouts)
        columns=[traffic(l,x['waves'],False) for l in layouts];costs=list(map(list,zip(*columns)))
        expect(costs==x['costs'],'online full-information costs')
        digests=[hashlib.sha256(canonical(l)).hexdigest() for l in layouts]
        migration=[[0 if digests[a]==digests[b] else len(canonical(layouts[b]))+sum(p for _,p in decode(layouts[b])) for b in range(k)] for a in range(k)]
        expect(migration==x['migration'],'manifest plus full reconstruction migration')
        for name,path_actions in x['actions'].items():
            expect(len(path_actions)==len(costs),'complete selected path')
            service=sum(costs[t][a] for t,a in enumerate(path_actions))
            fee=sum(migration[a][b] for a,b in zip(path_actions,path_actions[1:]))
            method=s['methods'][name]
            expect(service==method['service_bytes'] and fee==method['switch_bytes'] and service+fee==method['total_bytes'],'charged online path')
        dp=costs[0][:]
        for row in costs[1:]:dp=[row[j]+min(dp[i]+migration[i][j] for i in range(k)) for j in range(k)]
        expect(min(dp)==s['methods']['switching_oracle_hindsight']['total_bytes'],'independent clairvoyant DP')
        expect(min(sum(row[j] for row in costs) for j in range(k))==s['methods']['best_static_hindsight']['total_bytes'],'static hindsight')
        counts['online_streams']+=1;counts['online_events']+=len(costs);online.append(s)
    expect(counts['online_streams']==80,'complete online cohort')
    for project in load(out/'real_replay_summary.json'):
        plans={k:load(out/'real_replay'/project['project']/f'layout-{k}.json') for k in ('original','spectral','cluster','shuffled','fixed8')}
        for record in project['records']:
            for name,layout in plans.items():expect(traffic(layout,[record['waves']])[0]==record['costs'][name],'source replay traffic')
            counts['replayed_source_cases']+=1
    expect(counts['replayed_source_cases']==33,'archived replay count')
    rows=load(out/'fresh_checker_summary.json');expect(len(rows)==24,'complete paired fresh cohort')
    pairs={}
    for row in rows:
        p=out/'fresh_checkers'/row['project']/(row['id']+'-'+row['method']);r=load(p/'report.json')
        expect(r==row['report'],'fresh record matches emitted report')
        expect(r['verdict']==row['expected'],'fresh oracle agreement')
        expect(r['packet_bytes']==traffic({'registry':[str(i) for i in range(r['required'])], 'order':r['layout_order'],'tree':r['tree'],'model':{'header':512,'card':320,'cap':3072}},_waves_from_probe(p))[0],'fresh packet-cost formula')
        pairs.setdefault((row['project'],row['id']),[]).append(row)
        counts['fresh_paired_runs']+=1
    for pair in pairs.values():
        expect(len(pair)==2 and {r['method'] for r in pair}=={'fixed8','cluster'},'matched fresh pair')
        expect(pair[0]['report']['executed']==pair[1]['report']['executed'],'same executed checks')
        project=pair[0]['project'];mid=pair[0]['id'];m=load(root/'historical/results_v2/mutations'/(mid+'.json'))['mutation']
        src=(root/'vendor'/project/m['source']).read_bytes()
        expect(hashlib.sha256(src).hexdigest()==m['base_sha256'],'pinned source input')
        left,right=m['span'];text=src.decode();patch=(text[:left]+m['replacement']+text[right:]).encode()
        expect(hashlib.sha256(patch).hexdigest()==m['mutant_sha256'],'exact archived intervention')
    for path in sorted(out.rglob('report.json')):
        r=load(path)
        if 'packet_bytes' not in r:continue
        counts['packets']+=check_packets(path.with_name('certificate_packets.bin'),r);counts['packet_streams']+=1
        raw=load(path.with_name('pytest_evidence.json'))
        if r['verdict']=='PASS':
            expect(r['executed']==r['required'] and r['counts']==[r['required'],0,0] and r['locally_authorized'],'complete PASS')
            expect(len(raw['records'])==r['required'] and all(v['status']=='PASS' for v in raw['records'].values()),'independent recorded PASS coverage')
    harness=load(out/'harness_summary.json');expect(len(harness)==9,'complete harness cohort')
    for r in harness:
        expect(r['task_states']=={'project':'done','ledger':'done','transport':'done'},'completed real runtime graph')
        expect(r['peak_workers']==2 and r['http_503']==1,'parallelism and transport fault')
        expect(r['hosted_llm_tokens'] is None and all(v['actual_tokens'] is None for v in r['provider_usage_rows']),'do not manufacture token evidence')
        expect(sum(q['status']==503 for q in r['http_requests'])==1,'recorded outage')
        expect(sum(q['message_utf8_bytes'] for q in r['http_requests'])==r['total_prompt_message_bytes'],'prompt bytes')
        expect(r['largest_prompt_message_bytes']<=16384,'actual bounded messages')
        counts['harness_episodes']+=1
    stats=load(out/'statistics.json')
    for kind,value in stats['ordering'].items():
        selected=[r for r in ordering if r['kind']==kind]
        for baseline in ('original','fixed8'):
            vals=[100*(1-r['total_bytes']['selected']/r['total_bytes'][baseline]) for r in selected]
            actual=ci(vals);reported=value[baseline]
            expect(np.allclose(actual,[reported[x] for x in ('mean','low','high')]),'independent bootstrap ordering');counts['statistics_verified']+=1
    for mode,value in stats['online'].items():
        selected=[r for r in online if r['mode']==mode]
        for method,reported in value.items():
            actual=ci([r['methods'][method]['total_bytes']/r['methods']['frozen']['total_bytes'] for r in selected])
            expect(np.allclose(actual,[reported[x] for x in ('mean','low','high')]),'independent bootstrap online');counts['statistics_verified']+=1
    for project,values in stats['fresh'].items():
        for method in ('fixed8','cluster'):
            subset=[r for r in rows if r['project']==project and r['method']==method]
            expect(len(subset)==values[method]['runs']==4,'no empty cost cohorts')
            expect(sum(r['report']['packet_bytes'] for r in subset)==values[method]['packet_bytes'],'fresh statistics')
    return {'verdict':'PASS','scope':'Independent reconstruction of stored costs, packet streams, coverage, provenance and statistics; not external replication or hosted-LLM evaluation','counts':counts}


def _waves_from_probe(directory):
    raw=load(directory/'pytest_evidence.json');index={g:i for i,g in enumerate(raw['registry'])}
    seq=[index[g] for g in raw['executed']]
    return [[seq[i:i+8] for i in range(0,len(seq),8)]]


if __name__=='__main__':
    result=audit();(ROOT/'audit/v3_audit.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
