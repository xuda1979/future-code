#!/usr/bin/env python3
"""Bounded receiver for authorized measurements. No payload is stored.
Deploy only on a controlled host, behind a firewall restricting client access.
The minimal measurement receiver does NOT implement application user accounts.
It listens locally unless --bind and --authorize-network-bind are explicit.
"""
import argparse,json,socket,ssl,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from ichact.tls_probe import receive_one

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--bind',default='127.0.0.1');p.add_argument('--port',type=int,default=8443)
    p.add_argument('--cert',required=True);p.add_argument('--key',required=True);p.add_argument('--connections',type=int,default=1)
    p.add_argument('--authorize-network-bind',action='store_true');p.add_argument('--output',type=Path,required=True)
    a=p.parse_args()
    if a.bind!='127.0.0.1' and not a.authorize_network_bind:raise ValueError('network binding needs explicit approval')
    if not 1<=a.connections<=1000 or a.output.exists():raise ValueError('bounded run and new output required')
    ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.minimum_version=ssl.TLSVersion.TLSv1_2;ctx.load_cert_chain(a.cert,a.key)
    a.output.parent.mkdir(parents=True,exist_ok=True)
    with socket.socket() as listener,a.output.open('x') as log:
        listener.settimeout(120);listener.bind((a.bind,a.port));listener.listen(5)
        for _ in range(a.connections):
            raw,_=listener.accept();raw.settimeout(30)
            try:
                with ctx.wrap_socket(raw,server_side=True) as stream:row=receive_one(stream)
            except (ValueError,OSError,ssl.SSLError) as exc:
                raw.close();row={'status':'ERROR','reason':str(exc)}
            log.write(json.dumps(row)+'\n');log.flush()
if __name__=='__main__':main()
