"""Re-aggregate archived trusted completion records under the new default.

No checker or LLM runs here. The order was learned only from v2 training data
and frozen in v3. Do not pool these replays with fresh-source executions.
"""
from pathlib import Path
import hashlib,json
from hact.certificates import digest
from ichact.adaptive_guard import AdaptiveGuard
from ichact.layout import Layout
from ichact.practical import balanced_layout
from ichact.exposure import encode_wire,status_prompt,diagnostic_pages,compact_packet
ROOT=Path(__file__).resolve().parents[1]

def main():
    dest=ROOT/'results/v5/source_replay'
    if dest.exists():raise ValueError('refuse to overwrite a replay cohort')
    dest.mkdir(parents=True);summary=[]
    rows=[x for x in json.loads((ROOT/'results/v3/fresh_checker_summary.json').read_text()) if x['method']=='fixed8']
    assert len(rows)==12
    for old in rows:
        project=old['project'];case=old['id'];source=ROOT/'results/v3/fresh_checkers'/project/f'{case}-fixed8'
        evpath=source/'pytest_evidence.json';e=json.loads(evpath.read_text());r=old['report']
        trained=Layout.from_dict(json.loads((ROOT/'results/v3/real_replay'/project/'layout-cluster.json').read_text()))
        ids=tuple(e['registry']);assert ids==trained.registry
        layouts={'fixed8':balanced_layout(ids),'learned_balanced':balanced_layout(ids,trained.order),'learned_exact':trained}
        waves=[e['executed'][i:i+8] for i in range(0,len(e['executed']),8)]
        for method,layout in layouts.items():
            guard=AdaptiveGuard(ids,r['snapshot'],r['checker'],r['environment'],layout)
            _,packets=guard.refresh();all_packets=list(packets)
            for wave in waves:
                for g in wave:
                    rec=e['records'][g];guard.submit(guard.token(g),rec['status'],digest(rec))
                _,packets=guard.refresh();all_packets.extend(packets)
            final,_=guard.refresh();assert list(final.counts)==r['counts']
            authorized=guard.authorize(guard.issue()) if final.verdict=='PASS' else False
            assert final.verdict==r['verdict'] and authorized==r['locally_authorized']
            report={**r,'tree':layout.tree.to_dict(),'layout_order':list(layout.order),'layout_id':layout.uid,
                    'packet_bytes':sum(map(len,all_packets)),'packet_count':len(all_packets),
                    'largest_packet_bytes':max(map(len,all_packets)),
                    'verdict':final.verdict,'counts':list(final.counts),'locally_authorized':authorized,
                    'pytest_process_seconds':None,'complete_wrapper_seconds':None,
                    'preparation_seconds':None,'snapshot_copy_seconds':None,'aggregation_seconds':None,
                    'timing_boundary':'Re-aggregation only: no fresh checker execution or wrapper time measurement'}
            out=dest/f'{case}-{method}';out.mkdir()
            blob=b''.join(all_packets);(out/'certificate_packets.bin').write_bytes(blob)
            (out/'report.json').write_text(json.dumps(report,indent=2))
            root=status_prompt(report);pages=diagnostic_pages(all_packets)
            summary.append(dict(project=project,id=case,method=method,source=str(out.relative_to(ROOT)),
                original_evidence=str(evpath.relative_to(ROOT)),original_evidence_sha256=hashlib.sha256(evpath.read_bytes()).hexdigest(),
                source_sha256=hashlib.sha256(blob).hexdigest(),packet_bytes=len(blob),packet_count=len(all_packets),
                layout=layout.to_dict(),wire_bytes={m:len(encode_wire(all_packets,m))+40 for m in ('padded','compact','packet_zlib','batch_zlib')},
                root_prompt=root.decode(),root_prompt_bytes=len(root),root_sha256=hashlib.sha256(root).hexdigest(),root_prompt_tokens=None,
                diagnostic_pages=len(pages),diagnostic_total_input_bytes=sum(map(len,pages)),diagnostic_max_page_bytes=max(map(len,pages)),
                provenance='new serialization of archived results, not new checking'))
    (ROOT/'results/v5/source_replay.json').write_text(json.dumps(summary,indent=2))
    print(len(summary),'source-evidence layout replays; zero new checker executions')
if __name__=='__main__':main()
