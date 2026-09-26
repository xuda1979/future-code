"""Explicit-host TLS transport instrumentation, not a verification authority.

Run only against a receiver the operator owns/authorizes. No fallback disables
certificate validation. Server acknowledgments confirm transport bytes, not
program correctness. No packet-loss/RTT metrics are invented from application
wall time. Used here only for local protocol tests, not a physical WAN claim.
"""
from __future__ import annotations
import hashlib,json,socket,ssl,struct,time
from .exposure import MAX_ARCHIVE,decode_wire
LENGTH=struct.Struct('!Q')


def recv_exact(stream,size):
    data=bytearray()
    while len(data)<size:
        chunk=stream.recv(size-len(data))
        if not chunk:raise ValueError('truncated TLS application frame')
        data.extend(chunk)
    return bytes(data)


def receive_one(stream, *, limit=2*MAX_ARCHIVE):
    if type(limit) is not int or not 0<limit<=2*MAX_ARCHIVE:
        raise ValueError('bounded receiver limit required')
    size=LENGTH.unpack(recv_exact(stream,LENGTH.size))[0]
    if not 0<size<=limit:raise ValueError('application frame exceeds receiver limit')
    start=time.perf_counter();wire=recv_exact(stream,size)
    packets=decode_wire(wire)
    ack={'status':'received','payload_sha256':hashlib.sha256(wire).hexdigest(),
         'wire_bytes':size,'decoded_packets':len(packets)}
    data=json.dumps(ack,sort_keys=True,separators=(',',':')).encode()
    stream.sendall(LENGTH.pack(len(data))+data)
    return {**ack,'receiver_service_seconds':time.perf_counter()-start}


def send_one(stream,wire):
    packets=decode_wire(wire)  # reject malformed local input before transmission
    start=time.perf_counter();stream.sendall(LENGTH.pack(len(wire))+wire)
    n=LENGTH.unpack(recv_exact(stream,LENGTH.size))[0]
    if not 0<n<=4096:raise ValueError('invalid acknowledgment size')
    ack=json.loads(recv_exact(stream,n))
    expected=hashlib.sha256(wire).hexdigest()
    if (not isinstance(ack,dict) or ack.get('status')!='received' or
        ack.get('payload_sha256')!=expected or type(ack.get('wire_bytes')) is not int or
        ack.get('wire_bytes')!=len(wire) or type(ack.get('decoded_packets')) is not int or
        ack.get('decoded_packets')!=len(packets)):
        raise ValueError('mismatched transport acknowledgment')
    return {**ack,'send_to_ack_seconds':time.perf_counter()-start,
            'application_bytes':len(wire)+2*LENGTH.size+n,
            'semantic_authorization':False}


def connect(host,port,*,cafile=None,server_hostname=None,timeout=30):
    if not isinstance(host,str) or not host or type(port) is not int or not 1<=port<=65535:
        raise ValueError('explicit host and valid port required')
    if isinstance(timeout,bool) or not isinstance(timeout,(int,float)) or not 0<timeout<=300:
        raise ValueError('bounded timeout required')
    context=ssl.create_default_context(cafile=cafile)
    context.minimum_version=ssl.TLSVersion.TLSv1_2
    start=time.perf_counter();raw=socket.create_connection((host,port),timeout=timeout)
    tcp=time.perf_counter()-start;start=time.perf_counter()
    try:stream=context.wrap_socket(raw,server_hostname=server_hostname or host)
    except BaseException:
        raw.close();raise
    return stream,{'connect_including_dns_seconds':tcp,'tls_handshake_seconds':time.perf_counter()-start,
                   'tls_version':stream.version(),'cipher':stream.cipher()[0],
                   'peer_certificate_sha256':hashlib.sha256(stream.getpeercert(binary_form=True)).hexdigest(),
                   'endpoint_host':host,'endpoint_port':port,'physical_path_classification':'OPERATOR_MUST_SUPPLY',
                   'network_RTT_seconds':None,'IP_bytes':None,'packet_loss':None,'retransmissions':None}
