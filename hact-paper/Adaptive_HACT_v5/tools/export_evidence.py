#!/usr/bin/env python3
"""Export a TRUSTED gate report and its packet stream; refuses existing outputs.
This is a display/export tool, NOT a gate granting authorization to untrusted JSON.
"""
import argparse,json
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from ichact.exposure import split_packets,encode_wire,decode_wire,status_prompt,diagnostic_pages

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--report',type=Path,required=True);p.add_argument('--packets',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True);p.add_argument('--mode',choices=['padded','compact','packet_zlib','batch_zlib'],default='packet_zlib')
    a=p.parse_args()
    if a.output.exists():raise ValueError('output must be new; existing evidence is not overwritten')
    report=json.loads(a.report.read_text());packets=split_packets(a.packets.read_bytes());root=status_prompt(report)
    wire=encode_wire(packets,a.mode);decode_wire(wire);pages=diagnostic_pages(packets)
    a.output.mkdir(parents=True);(a.output/'status.txt').write_bytes(root);(a.output/'evidence.hact').write_bytes(wire)
    for i,page in enumerate(pages):(a.output/f'diagnostic-{i:04d}.txt').write_bytes(page)
    (a.output/'export.json').write_text(json.dumps({'mode':a.mode,'wire_bytes':len(wire),'root_bytes':len(root),'diagnostic_pages':len(pages),
        'provider_tokens':None,'boundary':'Trusted-local display only; no network authentication or new publication grant.'},indent=2))
if __name__=='__main__':main()
