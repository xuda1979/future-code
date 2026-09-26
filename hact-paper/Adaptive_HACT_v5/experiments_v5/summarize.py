"""Descriptive cohort summaries. Three seeds: report ranges, not tight CIs."""
from pathlib import Path
import json,statistics
ROOT=Path(__file__).resolve().parents[1]
def main():
    out=ROOT/'results/v5';p=json.loads((out/'practical.json').read_text());r=json.loads((out/'source_replay.json').read_text())
    summary={'schema':'hact-v5-summary-1','synthetic_workloads':len(p),'historical_candidates':12,'layout_replays':len(r),
             'new_checker_executions':0,'physical_WAN_trials':0,'hosted_LLM_trials':0,'actual_BPE_counts':None,
             'synthetic':[],'projects':[]}
    for n in sorted({x['n'] for x in p}):
        for kind in ('cluster','independent','global'):
            group=[x for x in p if (x['n'],x['kind'])==(n,kind)]
            reductions=[100*(1-x['heldout_totals'][x['selected']]/x['heldout_totals']['incumbent']) for x in group]
            summary['synthetic'].append(dict(n=n,kind=kind,seeds=len(group),heldout_reduction_mean=statistics.mean(reductions),
                heldout_reduction_range=[min(reductions),max(reductions)],fit_seconds_median=statistics.median(x['fit_seconds'] for x in group),
                changed=sum(x['selected']!='incumbent' for x in group)))
    for project in ('networkx','toolz','future'):
        row={'project':project,'bytes':{},'diagnostic_pages':{},'diagnostic_input_bytes':{}}
        for method in ('fixed8','learned_balanced','learned_exact'):
            group=[x for x in r if (x['project'],x['method'])==(project,method)];assert len(group)==4
            row['bytes'][method]={mode:sum(x['wire_bytes'][mode] for x in group) for mode in ('padded','compact','packet_zlib','batch_zlib')}
            row['diagnostic_pages'][method]=sum(x['diagnostic_pages'] for x in group)
            row['diagnostic_input_bytes'][method]=sum(x['diagnostic_total_input_bytes'] for x in group)
        row['balanced_reduction_percent']={mode:100*(1-row['bytes']['learned_balanced'][mode]/row['bytes']['fixed8'][mode]) for mode in row['bytes']['fixed8']}
        summary['projects'].append(row)
    summary['root_identical_triples']=sum(len({x['root_sha256'] for x in r if (x['project'],x['id'])==key})==1 for key in {(x['project'],x['id']) for x in r})
    summary['root_bytes_range']=[min(x['root_prompt_bytes'] for x in r),max(x['root_prompt_bytes'] for x in r)]
    summary['max_diagnostic_bytes']=max(x['diagnostic_max_page_bytes'] for x in r)
    summary['diagnostic_pages']={method:sum(x['diagnostic_pages'] for x in r if x['method']==method) for method in ('fixed8','learned_balanced','learned_exact')}
    (out/'summary.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary,indent=2))
if __name__=='__main__':main()
