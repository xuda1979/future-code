"""Subprocess acceptance gate for Future Code Control's GateSpec.

Run this installed module or its absolute trusted launcher outside agent write
scopes. Non-PASS exits nonzero, so the existing harness rejects the candidate.
Detailed evidence lives outside the candidate; only a bounded JSON card returns.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import sys
import time
import uuid

# Support a pinned absolute script path in GateSpec without PYTHONPATH mutation.
if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ichact.cli import operate
from ichact.layout import Layout


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--contract',required=True,type=Path)
    p.add_argument('--reports',required=True,type=Path)
    p.add_argument('--layout',type=Path)
    p.add_argument('--order',type=Path)
    p.add_argument('--project',type=Path,default=Path.cwd())
    p.add_argument('--timeout',type=float,default=60)
    args=p.parse_args();start=time.perf_counter()
    output=args.reports.resolve()/('verify-'+uuid.uuid4().hex)
    try:
        result=operate(args.project,args.contract,output,timeout=args.timeout,
            layout=Layout.from_dict(json.loads(args.layout.read_text())) if args.layout else None,
            order=json.loads(args.order.read_text()) if args.order else None)
        card={k:result[k] for k in ('verdict','required','executed','counts','snapshot','registry_hash','layout_id','packet_bytes','largest_packet_bytes')}
        card['report']=str(output/'report.json')
        card['bridge_wall_seconds']=time.perf_counter()-start
        card['hosted_llm_tokens']=None
        print(json.dumps(card,sort_keys=True,separators=(',',':')))
        return 0 if result['verdict']=='PASS' else 1 if result['verdict']=='FAIL' else 2
    except (ValueError,OSError,KeyError,TypeError) as error:
        print(json.dumps({'verdict':'UNKNOWN','error':str(error)[:500],'report':str(output),'hosted_llm_tokens':None},sort_keys=True))
        return 2
if __name__=='__main__':raise SystemExit(main())
