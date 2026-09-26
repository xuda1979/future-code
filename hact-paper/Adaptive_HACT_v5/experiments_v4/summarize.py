"""Descriptive summaries of all frozen v4 observations; no discarded trials."""
import json,statistics
from pathlib import Path
from collections import defaultdict
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'results/v4'

def main():
    exposure=json.loads((OUT/'exposure.json').read_text())
    transfers=[json.loads(s) for s in (OUT/'transport.jsonl').read_text().splitlines()]
    assert len(exposure)==24 and len(transfers)==288
    projects=[]
    for name in ('networkx','toolz','future'):
        a=[r for r in exposure if r['project']==name and r['method']=='fixed8']
        b=[r for r in exposure if r['project']==name and r['method']!='fixed8']
        x={'project':name,'pairs':4,'wire_reduction_percent':{},'bytes':{}}
        for mode in ('padded','compact','packet_zlib','batch_zlib'):
            aa=sum(r['wire_bytes'][mode] for r in a);bb=sum(r['wire_bytes'][mode] for r in b)
            x['wire_reduction_percent'][mode]=100*(1-bb/aa);x['bytes'][mode]={'fixed':aa,'learned':bb}
        for key in ('diagnostic_pages','diagnostic_total_input_bytes','flat_status_ledger_bytes','flat_status_ledger_zlib_bytes'):
            x[key]={'fixed':sum(r[key] for r in a),'learned':sum(r[key] for r in b)}
        projects.append(x)
    timing=[]
    for rate in (65536,1048576,None):
        for mode in ('compact','batch_zlib'):
            def rows(method):return [r for r in transfers if r['rate_bytes_per_second']==rate and r['mode']==mode and (r['method']=='fixed8')==method]
            a=rows(True);b=rows(False)
            assert len(a)==len(b)==24
            av=sum(r['total_export_seconds'] for r in a)/2;bv=sum(r['total_export_seconds'] for r in b)/2
            timing.append({'rate_bytes_per_second':rate,'mode':mode,'fixed_seconds_per_12_exports':av,'learned_seconds_per_12_exports':bv,
                           'reduction_percent':100*(1-bv/av),'trials':48,'fixed_encode_seconds':sum(r['encoding_seconds'] for r in a)/2,
                           'learned_encode_seconds':sum(r['encoding_seconds'] for r in b)/2})
    scale=json.loads((OUT/'scaling.json').read_text());assert len(scale)==18
    sc=[]
    for n in (128,512,1024):
        for kind in ('cluster','independent'):
            group=[r for r in scale if r['n']==n and r['kind']==kind]
            exact=[r['exact_fit_seconds'] for r in group if r['exact_fit_seconds'] is not None]
            sc.append({'n':n,'kind':kind,'seeds':3,'order_seconds_median':statistics.median(r['order_seconds'] for r in group),
                       'blocked_seconds_median':statistics.median(r['blocked_fit_seconds'] for r in group),
                       'exact_seconds_median':statistics.median(exact) if exact else None,
                       'heldout_penalty_vs_exact_percent':statistics.mean(100*(r['heldout_cost']['blocked32']/r['heldout_cost']['exact']-1) for r in group) if exact else None,
                       'heldout_vs_fixed8_learned_percent':statistics.mean(100*(r['heldout_cost']['blocked32']/r['heldout_cost']['fixed8_learned']-1) for r in group)})
    paired={}
    for r in exposure:paired.setdefault((r['project'],r['id']),[]).append(r)
    assert all(len(v)==2 and v[0]['root_sha256']==v[1]['root_sha256'] for v in paired.values())
    summary={'projects':projects,'timing':timing,'scaling':sc,'root_prompt_bytes_range':[min(r['root_prompt_bytes'] for r in exposure),max(r['root_prompt_bytes'] for r in exposure)],
             'root_identical_pairs':len(paired),'max_diagnostic_bytes':max(r['diagnostic_max_page_bytes'] for r in exposure),
             'max_local_packet_bytes':max(r['max_single_compact_packet_bytes'] for r in exposure),'tokenizer_counts':None,'provider_usage':None,
             'scope':'Controlled export of archived verification data; neither fresh model trials nor new checker outcomes'}
    (OUT/'summary.json').write_text(json.dumps(summary,indent=2))
    p=ROOT/'paper/generated_v4';p.mkdir(exist_ok=True)
    rows=[]
    for x in projects:
        r=x['wire_reduction_percent'];rows.append(f"{x['project']} & {r['padded']:.2f} & {r['compact']:.2f} & {r['packet_zlib']:.2f} & {r['batch_zlib']:.2f} \\\\")
    (p/'wire_rows.tex').write_text('\n'.join(rows)+'\n')
    rows=[]
    for x in timing:
        rate='Unpaced' if x['rate_bytes_per_second'] is None else ('64 KiB/s' if x['rate_bytes_per_second']==65536 else '1 MiB/s')
        mode='Canonical' if x['mode']=='compact' else 'Epoch-compressed'
        rows.append(f"{rate} & {mode} & {x['fixed_seconds_per_12_exports']:.3f} & {x['learned_seconds_per_12_exports']:.3f} & {x['reduction_percent']:.2f} \\\\")
    (p/'timing_rows.tex').write_text('\n'.join(rows)+'\n')
    rows=[]
    for x in sc:
        ex='--' if x['exact_seconds_median'] is None else f"{x['exact_seconds_median']:.3f}"
        gap='--' if x['heldout_penalty_vs_exact_percent'] is None else f"{x['heldout_penalty_vs_exact_percent']:+.2f}"
        rows.append(f"{x['n']} & {x['kind']} & {x['order_seconds_median']:.3f} & {ex} & {x['blocked_seconds_median']:.3f} & {gap} \\\\")
    (p/'scaling_rows.tex').write_text('\n'.join(rows)+'\n')
    print(json.dumps(summary,indent=2))
if __name__=='__main__':main()
