"""Regenerate v3 tables from measured records; bootstrap independent seed units."""
from pathlib import Path
import json
import numpy as np
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'results/v3';GEN=ROOT/'paper/generated'

def load(name):return json.loads((OUT/(name+'.json')).read_text())
def interval(values,seed=94001):
    a=np.asarray(values,dtype=float);rng=np.random.default_rng(seed)
    samples=a[rng.integers(len(a),size=(10000,len(a)))].mean(axis=1)
    return {'mean':float(a.mean()),'low':float(np.quantile(samples,.025)),'high':float(np.quantile(samples,.975)),'n':len(a)}
def texci(d):return f"{d['mean']:.2f} [{d['low']:.2f}, {d['high']:.2f}]"
def main():
    GEN.mkdir(parents=True,exist_ok=True);statistics={};lines=[]
    data=load('ordering_summary');statistics['ordering']={}
    for kind in ('cluster','independent','singleton','global'):
        group=[r for r in data if r['kind']==kind];out={}
        for base in ('original','fixed8'):
            out[base]=interval([100*(1-r['total_bytes']['selected']/r['total_bytes'][base]) for r in group])
        statistics['ordering'][kind]=out
        lines.append(kind.replace('_',' ')+f" & {texci(out['original'])} & {texci(out['fixed8'])} \\")
    (GEN/'ordering_rows.tex').write_text('\n'.join(lines)+'\n')
    data=load('online_summary');statistics['online']={};lines=[]
    methods=['coupled_share','independent_share','coupled_static','window_priced','greedy_unpriced','switching_oracle_hindsight']
    for mode in ('stationary','long_shift','rapid_shift','global'):
        group=[r for r in data if r['mode']==mode];out={}
        for name in methods:
            out[name]=interval([r['methods'][name]['total_bytes']/r['methods']['frozen']['total_bytes'] for r in group])
            out[name]['mean_switches']=float(np.mean([r['methods'][name].get('switches',0) for r in group]))
        statistics['online'][mode]=out
        lines.append(mode.replace('_',' ')+''.join(f" & {out[n]['mean']:.3f}" for n in methods)+' \\\\')
    (GEN/'online_rows.tex').write_text('\n'.join(lines)+'\n')
    data=load('real_replay_summary');statistics['replay']={};lines=[]
    for r in data:
        costs={k:sum(case['costs'][k] for case in r['records']) for k in r['records'][0]['costs']}
        out={k:100*(1-costs['selected']/costs[k]) for k in ('original','fixed8','shuffled')}
        out.update(n=r['n'],cases=len(r['records']),fitting_seconds=r['fitting_seconds'])
        statistics['replay'][r['project']]=out
        lines.append(f"{r['project']} & {r['n']} & {len(r['records'])} & {out['original']:.2f} & {out['fixed8']:.2f} & {out['shuffled']:.2f} \\")
    (GEN/'replay_rows.tex').write_text('\n'.join(lines)+'\n')
    data=load('fresh_checker_summary');statistics['fresh']={};lines=[]
    for project in ('networkx','toolz','future'):
        group=[r for r in data if r['project']==project];out={}
        for name in ('fixed8','cluster'):
            items=[r for r in group if r['method']==name]
            if len(items)!=4:raise ValueError('fresh measurement cohort incomplete or mislabeled')
            out[name]={'runs':len(items),'wall_seconds':sum(r['observed_wall_seconds'] for r in items),
                       'packet_bytes':sum(r['report']['packet_bytes'] for r in items),
                       'pytest_seconds':sum(r['report']['pytest_process_seconds'] for r in items),
                       'prepare_seconds':sum(r['report']['preparation_seconds'] for r in items),
                       'snapshot_seconds':sum(r['report']['snapshot_copy_seconds'] for r in items),
                       'aggregate_seconds':sum(r['report']['aggregation_seconds'] for r in items)}
        out['bytes_reduction']=100*(1-out['cluster']['packet_bytes']/out['fixed8']['packet_bytes'])
        out['wall_reduction']=100*(1-out['cluster']['wall_seconds']/out['fixed8']['wall_seconds'])
        statistics['fresh'][project]=out
        lines.append(f"{project} & {out['fixed8']['packet_bytes']/1024:.1f} & {out['cluster']['packet_bytes']/1024:.1f} & {out['bytes_reduction']:.2f} & {out['fixed8']['wall_seconds']:.2f} & {out['cluster']['wall_seconds']:.2f} \\")
    (GEN/'fresh_rows.tex').write_text('\n'.join(lines)+'\n')
    if (OUT/'harness_summary.json').exists():
        data=load('harness_summary');statistics['harness']={};lines=[]
        for method in ('direct','fixed8','learned'):
            items=[r for r in data if r['method']==method]
            if not items:continue
            out={'episodes':len(items),'median_seconds':float(np.median([r['active_episode_seconds'] for r in items])),
                'min_seconds':min(r['active_episode_seconds'] for r in items),'max_seconds':max(r['active_episode_seconds'] for r in items),
                'mean_prompt_bytes':float(np.mean([r['total_prompt_message_bytes'] for r in items])),
                'maximum_prompt_bytes':max(r['largest_prompt_message_bytes'] for r in items),
                'mean_context_seconds':float(np.mean([r['context_construction_seconds'] for r in items])),
                'mean_init_seconds':float(np.mean([r['initialization_seconds'] for r in items])),
                'mean_packet_bytes':None if method=='direct' else float(np.mean([r['packet_bytes'] for r in items])),
                'hosted_llm_tokens':None,'peak_workers':max(r['peak_workers'] for r in items)}
            statistics['harness'][method]=out
            packet='--' if out['mean_packet_bytes'] is None else f"{out['mean_packet_bytes']/1024:.2f}"
            lines.append(f"{method} & {len(items)} & {out['median_seconds']:.2f} & {out['min_seconds']:.2f}--{out['max_seconds']:.2f} & {packet} & {out['mean_prompt_bytes']/1024:.2f} \\")
        (GEN/'harness_rows.tex').write_text('\n'.join(lines)+'\n')
    for table in GEN.glob('*_rows.tex'):
        table.write_text('\n'.join(line.rstrip('\\') + '\\\\' for line in table.read_text().splitlines())+'\n')
    (OUT/'statistics.json').write_text(json.dumps(statistics,indent=2))
    print(json.dumps(statistics,indent=2))
if __name__=='__main__':main()
