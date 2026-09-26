#!/usr/bin/env python3
"""Measure full exported diagnostic text with an ACTUAL installed tiktoken BPE.

Works on trusted archived input only. No provider is called. The library may
fetch its public vocabulary if not cached. No byte/token estimate is used.
Missing software/vocabulary writes UNKNOWN and exits 2, never a zero count.
"""
import argparse,hashlib,json,sys,platform
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from ichact.exposure import split_packets,status_prompt,diagnostic_pages
from ichact.token_budget import measure_text,token_bounded_pages

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--encoding',choices=['cl100k_base','o200k_base'],default='cl100k_base')
    p.add_argument('--cohort',choices=['v4','v5'],default='v5')
    p.add_argument('--token-budget',type=int,default=4096)
    p.add_argument('--reserved-tokens',type=int,default=0)
    a=p.parse_args()
    if a.output.exists():raise ValueError('refuse to overwrite measurements')
    report={'schema':'hact-bpe-measurement-1','encoding':a.encoding,'provider_tokens':None,
            'boundary':'exact supplied UTF-8 content only; excludes provider framing and outputs',
            'cohort':a.cohort,'token_budget':a.token_budget,'reserved_tokens':a.reserved_tokens}
    try:
        import tiktoken
        encoder=tiktoken.get_encoding(a.encoding)
        report['library_version']=tiktoken.__version__
        # Fingerprint actual vocabulary and pretokenizer used, not model aliases.
        h=hashlib.sha256()
        for raw,rank in sorted(encoder._mergeable_ranks.items(),key=lambda x:x[1]):
            h.update(len(raw).to_bytes(4,'big')+raw+int(rank).to_bytes(4,'big'))
        report['vocabulary_fingerprint']=h.hexdigest()
        report['pattern_sha256']=hashlib.sha256(encoder._pat_str.encode()).hexdigest()
        count=lambda s:len(encoder.encode(s,disallowed_special=()))
        data=[]
        cohort_path=ROOT/('results/v5/source_replay.json' if a.cohort=='v5' else 'results/v4/exposure.json')
        report['cohort_sha256']=hashlib.sha256(cohort_path.read_bytes()).hexdigest()
        for row in json.loads(cohort_path.read_text()):
            source=ROOT/row['source'];packets=split_packets((source/'certificate_packets.bin').read_bytes())
            local=json.loads((source/'report.json').read_text());root=status_prompt(local)
            pages=diagnostic_pages(packets)
            bounded=token_bounded_pages(packets,count,encoding=a.encoding,token_budget=a.token_budget,reserved_tokens=a.reserved_tokens)
            data.append({'project':row['project'],'id':row['id'],'method':row['method'],
                'root_bytes':len(root),'root_tokens':count(root.decode()),'root_sha256':hashlib.sha256(root).hexdigest(),
                'byte_limited_pages':[{'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b),'tokens':count(b.decode())} for b in pages],
                'dual_limited_pages':[{'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b),'tokens':count(b.decode())} for b in bounded]})
        report.update(status='MEASURED',records=data)
    except (ImportError,OSError,ValueError,RuntimeError) as exc:
        report.update(status='UNKNOWN',records=None,reason=f'{type(exc).__name__}: {exc}')
    a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(report,indent=2,allow_nan=False))
    print(report['status'],a.output)
    return 0 if report['status']=='MEASURED' else 2
if __name__=='__main__':raise SystemExit(main())
