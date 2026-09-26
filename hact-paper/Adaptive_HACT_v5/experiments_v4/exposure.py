"""Actual paced-loopback exports of ARCHIVED v3 checker packets.

No tests or models are re-run here. All 24 input streams are predetermined by
the released v3 checker cohort. Post-verification batching and single-bottleneck
pacing are explicit; these are not production edge or Internet measurements.
"""
from __future__ import annotations
import hashlib,json,os,platform,socket,struct,threading,time,zlib
from pathlib import Path
import numpy as np
from ichact.exposure import split_packets,compact_packet,encode_wire,decode_wire,status_prompt,diagnostic_pages,observed_tokens
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'results/v4'


def transfer(wire,rate,timeout=60):
    errors=[];recv_record={};expected=hashlib.sha256(wire).digest()
    listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen(1);listener.settimeout(timeout)
    def exact(s,n):
        a=bytearray()
        while len(a)<n:
            b=s.recv(n-len(a))
            if not b:raise ValueError('unexpected EOF')
            a.extend(b)
        return bytes(a)
    def receive():
        try:
            with listener.accept()[0] as s:
                s.settimeout(timeout);size=struct.unpack('!Q',exact(s,8))[0]
                if size!=len(wire):raise ValueError('length mismatch')
                start=time.perf_counter();raw=bytearray()
                while len(raw)<size:
                    part=s.recv(min(4096,size-len(raw)))
                    if not part:raise ValueError('premature EOF')
                    raw.extend(part)
                    if rate is not None:
                        delay=len(raw)/rate-(time.perf_counter()-start)
                        if delay>0:time.sleep(delay)
                recv_record['paced_receive_seconds']=time.perf_counter()-start
                t=time.perf_counter();digest=hashlib.sha256(raw).digest()
                if digest!=expected:raise ValueError('trusted expected digest mismatch')
                packets=decode_wire(bytes(raw));recv_record['decode_seconds']=time.perf_counter()-t
                recv_record['decoded_packets']=len(packets);s.sendall(digest)
        except Exception as e:errors.append(repr(e))
        finally:listener.close()
    worker=threading.Thread(target=receive,daemon=True);worker.start();t=time.perf_counter()
    try:
        with socket.create_connection(listener.getsockname(),timeout=timeout) as s:
            s.sendall(struct.pack('!Q',len(wire))+wire)
            ack=exact(s,32)
            if ack!=expected:raise ValueError('bad ACK')
    finally:worker.join(timeout)
    elapsed=time.perf_counter()-t
    if worker.is_alive() or errors:raise RuntimeError(str(errors) or 'receiver timeout')
    return dict(socket_roundtrip_seconds=elapsed,application_bytes=len(wire)+40,digest_verified=True,**recv_record)


def main():
    OUT.mkdir(exist_ok=True);rows=[];inputs=[]
    summaries=json.loads((ROOT/'results/v3/fresh_checker_summary.json').read_text())
    for row in summaries:
        p=ROOT/'results/v3/fresh_checkers'/row['project']/f"{row['id']}-{row['method']}"
        blob=(p/'certificate_packets.bin').read_bytes();packets=split_packets(blob);r=row['report']
        root=status_prompt(r);pages=diagnostic_pages(packets)
        meta={'project':row['project'],'id':row['id'],'method':row['method'],'source':str(p.relative_to(ROOT)),
              'source_sha256':hashlib.sha256(blob).hexdigest(),'packet_bytes':len(blob),'packet_count':len(packets),
              'wire_bytes':{m:len(encode_wire(packets,m))+40 for m in ('padded','compact','packet_zlib','batch_zlib')},
              'root_prompt_bytes':len(root),'root_sha256':hashlib.sha256(root).hexdigest(),'root_prompt_tokens':observed_tokens(root),
              'diagnostic_pages':len(pages),'diagnostic_total_input_bytes':sum(map(len,pages)),
              'diagnostic_max_page_bytes':max(map(len,pages)),'max_single_compact_packet_bytes':max(len(compact_packet(p)) for p in packets),
              'root_prompt':root.decode(),'hosted_llm':False}
        # An alternative flattened leaf-result export is a different delivery
        # contract: no hierarchical intermediate aggregation updates. Size only.
        ev=json.loads((p/'pytest_evidence.json').read_text())
        records=ev.get('records',{})
        leaf=[{'id':g,'status':v['status']} for g,v in sorted(records.items())]
        flat=json.dumps({'snapshot':r['snapshot'],'registry':r['registry_hash'],'results':leaf},sort_keys=True,separators=(',',':')).encode()
        meta['flat_status_ledger_bytes']=len(flat);meta['flat_status_ledger_zlib_bytes']=len(zlib.compress(flat,6))
        inputs.append((meta,packets))
    (OUT/'exposure.json').write_text(json.dumps([x[0] for x in inputs],indent=2))
    jobs=[(i,mode,rate,rep) for i in range(len(inputs)) for mode in ('compact','batch_zlib') for rate in (65536,1048576,None) for rep in range(2)]
    np.random.default_rng(44001).shuffle(jobs)
    log=OUT/'transport.jsonl'
    with log.open('w') as f:
        for number,(i,mode,rate,rep) in enumerate(jobs):
            meta,packets=inputs[i];start=time.perf_counter();wire=encode_wire(packets,mode);enc=time.perf_counter()-start
            obs=transfer(wire,rate)
            row={'project':meta['project'],'id':meta['id'],'method':meta['method'],'mode':mode,'rate_bytes_per_second':rate,'repeat':rep,
                 'encoding_seconds':enc,'total_export_seconds':enc+obs['socket_roundtrip_seconds'],**obs}
            f.write(json.dumps(row)+'\n');f.flush()
            if number%24==0:print(number+1,'/',len(jobs),flush=True)
    env={'python':platform.python_version(),'platform':platform.platform(),'zlib_runtime':zlib.ZLIB_RUNTIME_VERSION,
         'provider_tokens':None,'tokenizer_attempt':'tiktoken unavailable; pip and public vocabulary download failed because network resolution unavailable; no byte/token estimate',
         'dataset':'24 archived v3 checker outputs; 288 new TCP exports','transport':'single loopback link, application receiver pacing; no TLS/IP byte accounting'}
    (OUT/'environment.json').write_text(json.dumps(env,indent=2))
    print('completed',len(jobs),'transfers',flush=True)

if __name__=='__main__':main()
