"""Matched compressed-byte planning scenarios. No network timing is invented."""
from pathlib import Path
import json
from decimal import Decimal
from ichact.deployment import assess_delivery
ROOT=Path(__file__).resolve().parents[1]

def paired_totals(inputs, mode, candidate="cluster"):
    by_pair={}
    for row in inputs:
        key=(row['project'],row['id']);methods=by_pair.setdefault(key,{})
        if row['method'] not in {'fixed8',candidate} or row['method'] in methods:
            raise ValueError('missing/unknown/duplicate method must not become zero cost')
        value=row['wire_bytes'][mode]
        if type(value) is not int or value<=0:raise ValueError('positive observed wire bytes required')
        methods[row['method']]=value
    if not by_pair or any(set(p)!={'fixed8',candidate} for p in by_pair.values()):
        raise ValueError('complete method pairs required')
    return {m:sum(p[m] for p in by_pair.values()) for m in ('fixed8',candidate)}

def main():
    inputs=[r for r in json.loads((ROOT/'results/v5/source_replay.json').read_text()) if r['method'] in ('fixed8','learned_balanced')]
    modes=('compact','packet_zlib','batch_zlib')
    contract=json.loads((ROOT/'docs/V5_EXPERIMENT_CONTRACT.json').read_text())['planning_scenarios']
    pairs={(r['project'],r['id']) for r in inputs}
    assert len(pairs)==12 and len(inputs)==24
    rows=[]
    for mode in modes:
        sums=paired_totals(inputs,mode,candidate="learned_balanced")
        for rate in contract['goodput_Bps']:
            for overhead in contract['assumed_extra_seconds_per_candidate']:
                args=dict(baseline_bytes=sums['fixed8'],candidate_bytes=sums['learned_balanced'],goodput_bytes_per_second=rate,copies=1,
                    extra_once_seconds=str(Decimal(str(overhead))*len(pairs)),extra_per_copy_seconds=0,
                    baseline_service='same-12-candidate-cohort/'+mode,candidate_service='same-12-candidate-cohort/'+mode)
                rows.append(dict(mode=mode,rate=rate,assumed_extra_per_candidate=overhead,inputs=args,**assess_delivery(**args).to_dict()))
    (ROOT/'results/v5/planning.json').write_text(json.dumps(rows,indent=2))
if __name__=='__main__':main()
