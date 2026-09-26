#!/usr/bin/env python3
"""One consent-gated cold TLS export to an operator-authorized receiver.
Never uploads by default. Use a distinct output file for every trial. This tool
records application timing, not IP loss, WAN RTT, or a provider's token usage.
"""
import argparse,json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from ichact.tls_probe import connect,send_one

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--host',required=True);p.add_argument('--port',type=int,required=True)
    p.add_argument('--wire-file',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--ca-file');p.add_argument('--server-name');p.add_argument('--authorize-upload',action='store_true')
    a=p.parse_args()
    if not a.authorize_upload:raise ValueError('explicit approval required before sending evidence')
    if a.output.exists():raise ValueError('refuse to overwrite a trial')
    if a.wire_file.stat().st_size>128*1024*1024:raise ValueError('oversized payload')
    wire=a.wire_file.read_bytes()
    stream,metadata=connect(a.host,a.port,cafile=a.ca_file,server_hostname=a.server_name)
    with stream:record=send_one(stream,wire)
    a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(metadata|record,indent=2))
if __name__=='__main__':main()
