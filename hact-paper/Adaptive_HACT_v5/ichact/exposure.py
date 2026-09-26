"""Bounded evidence export and diagnostic views, NOT a remote trust protocol.

The receiver needs an authenticated expected digest or trusted verifier channel.
A hash inside an attacker-controlled message does not authenticate that message.
Compression is transport-only; it never changes semantic certificate records.
"""
from __future__ import annotations
import hashlib,json,struct,zlib
from hact.certificates import canonical

MAGIC=b'HACTV4\r\n'
HEADER=struct.Struct('!8sBII')
MODES={'padded':0,'compact':1,'packet_zlib':2,'batch_zlib':3}
MAX_ARCHIVE=64*1024*1024
MAX_PACKETS=100000


def _hex(value):
    return isinstance(value,str) and len(value)==64 and all(c in '0123456789abcdef' for c in value)


def packet_objects(packet:bytes):
    if not isinstance(packet,bytes) or not packet or len(packet)>3072:raise ValueError('invalid certificate packet size')
    try:rows=[json.loads(line) for line in packet.splitlines() if line.strip()]
    except (ValueError,UnicodeError) as exc:raise ValueError('invalid JSON packet') from exc
    if len(rows)<3:raise ValueError('at least two child cards required')
    h=rows[0]
    if not isinstance(h,dict) or set(h)!={'schema','range','registry','instruction'} or h['schema']!='hact-1' or not _hex(h['registry']) or not isinstance(h['instruction'],str):raise ValueError('invalid header')
    def interval(r):
        if not isinstance(r,list) or len(r)!=2 or any(type(i) is not int for i in r) or not 0<=r[0]<=r[1]:raise ValueError('invalid interval')
        return r
    lo,hi=interval(h['range']);cursor=lo
    for c in rows[1:]:
        if not isinstance(c,dict) or set(c)!={'range','counts','binding','evidence','registry'}:raise ValueError('invalid child')
        a,b=interval(c['range'])
        if a!=cursor or b>hi or c['registry']!=h['registry']:raise ValueError('invalid partition')
        if not isinstance(c['counts'],list) or len(c['counts'])!=3 or any(type(v) is not int or v<0 for v in c['counts']) or sum(c['counts'])!=b-a+1:raise ValueError('invalid counts')
        if not all(_hex(c[k]) for k in ('binding','evidence','registry')):raise ValueError('invalid commitment')
        cursor=b+1
    if cursor!=hi+1:raise ValueError('incomplete partition')
    return rows


def split_packets(blob:bytes):
    if not isinstance(blob,bytes) or not blob or len(blob)>MAX_ARCHIVE:raise ValueError('empty or oversized archive')
    result=[];current=[]
    for line in blob.splitlines(keepends=True):
        try:value=json.loads(line)
        except (ValueError,UnicodeError) as exc:raise ValueError('invalid packet line') from exc
        if isinstance(value,dict) and value.get('schema')=='hact-1':
            if current:result.append(b''.join(current))
            current=[line]
        else:
            if not current:raise ValueError('card without header')
            current.append(line)
    if current:result.append(b''.join(current))
    if not 1<=len(result)<=MAX_PACKETS:raise ValueError('invalid packet count')
    for p in result:packet_objects(p)
    return result


def compact_packet(packet):
    return b''.join(canonical(row)+b'\n' for row in packet_objects(packet))


def _inflate(data,limit):
    obj=zlib.decompressobj()
    try:
        result=obj.decompress(data,limit+1)
    except zlib.error as exc:raise ValueError('invalid compressed payload') from exc
    if len(result)>limit or not obj.eof or obj.unused_data or obj.unconsumed_tail:raise ValueError('oversized, truncated or trailing compressed payload')
    return result


def encode_wire(packets,mode='compact'):
    if mode not in MODES or not 1<=len(packets)<=MAX_PACKETS:raise ValueError('invalid format or count')
    canonical_packets=[]
    for p in packets:
        packet_objects(p)
        canonical_packets.append(p if mode=='padded' else compact_packet(p))
    rawsize=sum(4+len(p) for p in canonical_packets)
    if rawsize>MAX_ARCHIVE:raise ValueError('oversized export')
    bodies=[zlib.compress(p,6) if mode=='packet_zlib' else p for p in canonical_packets]
    frames=b''.join(struct.pack('!I',len(p))+p for p in bodies)
    if mode=='batch_zlib':frames=zlib.compress(frames,6)
    return HEADER.pack(MAGIC,MODES[mode],len(packets),rawsize)+frames


def decode_wire(wire):
    if len(wire)<HEADER.size or len(wire)>2*MAX_ARCHIVE:raise ValueError('invalid wire size')
    magic,mode,count,rawsize=HEADER.unpack(wire[:HEADER.size])
    if magic!=MAGIC or mode not in MODES.values() or not 1<=count<=MAX_PACKETS or not 0<rawsize<=MAX_ARCHIVE:raise ValueError('invalid envelope')
    body=wire[HEADER.size:]
    if mode==3:body=_inflate(body,rawsize)
    offset=0;packets=[];actual=0
    for _ in range(count):
        if offset+4>len(body):raise ValueError('truncated length')
        length=struct.unpack('!I',body[offset:offset+4])[0];offset+=4
        if not 0<length<=MAX_ARCHIVE or offset+length>len(body):raise ValueError('truncated packet')
        p=body[offset:offset+length];offset+=length
        if mode==2:p=_inflate(p,3072)
        packet_objects(p);packets.append(p);actual+=len(p)+4
    if offset!=len(body) or actual!=rawsize:raise ValueError('trailing or inconsistent data')
    return packets


def status_prompt(report):
    """Layout-invariant presentation of a TRUSTED local report, not authorization."""
    required=report.get('required');counts=report.get('counts')
    if type(required) is not int or required<1 or not isinstance(counts,list) or len(counts)!=3 or any(type(v) is not int or v<0 for v in counts) or sum(counts)!=required:raise ValueError('invalid status counts')
    for k in ('snapshot','checker','environment','registry_hash'):
        if not _hex(report.get(k)):raise ValueError('identity missing')
    authorized=report.get('locally_authorized') is True
    verdict='FAIL' if counts[1] else ('PASS' if counts==[required,0,0] and authorized else 'UNKNOWN')
    card={k:report[k] for k in ('snapshot','checker','environment','registry_hash')}
    card.update(schema='hact-status-1',required=required,counts=counts,verdict=verdict,
                authorization='trusted-local-report; revalidate at commit',provider_tokens=None)
    return (b'Report only the recorded verification state. PASS means the declared checks, not arbitrary program correctness.\n'+canonical(card)+b'\n')


def diagnostic_pages(packets,*,budget=16384):
    if type(budget) is not int or budget<1:raise ValueError('positive byte budget required')
    prefix=b'DIAGNOSTIC EVIDENCE. Counts are recorded facts, not a new authorization. Do not infer missing results.\n'
    pages=[];body=bytearray(prefix)
    for raw in packets:
        p=compact_packet(raw)
        if len(prefix)+len(p)>budget:raise ValueError('mandatory packet cannot fit; never truncate')
        if len(body)+len(p)>budget:pages.append(bytes(body));body=bytearray(prefix)
        body.extend(p)
    if len(body)>len(prefix):pages.append(bytes(body))
    return pages


def observed_tokens(text,encoding='cl100k_base'):
    """Optional real tokenizer; unavailable remains null, never len(text)/4."""
    try:
        import tiktoken
    except ImportError:return None
    try:return len(tiktoken.get_encoding(encoding).encode(text.decode('utf-8')))
    except (OSError,ValueError):return None
