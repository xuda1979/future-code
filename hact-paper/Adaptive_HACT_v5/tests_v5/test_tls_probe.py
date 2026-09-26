import hashlib,json,socket,ssl,struct,subprocess,threading
from pathlib import Path
import pytest
from hact.certificates import Kernel,Gate
from hact.tree import compact_balanced
from ichact.exposure import encode_wire
from ichact.tls_probe import connect,receive_one,send_one,recv_exact,LENGTH

@pytest.fixture(scope='module')
def cert(tmp_path_factory):
    p=tmp_path_factory.mktemp('tls-cert')
    subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(p/'key.pem'),'-out',str(p/'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    return p

@pytest.fixture
def wire():
    k=Kernel([Gate(str(i),('x',)) for i in range(9)],{'x':'v'})
    return encode_wire(k.refresh(compact_balanced(9,8))[1],'batch_zlib')


def server(cert,handler):
    listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen(1);listener.settimeout(4)
    port=listener.getsockname()[1];errors=[];rows=[]
    ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.load_cert_chain(str(cert/'cert.pem'),str(cert/'key.pem'))
    def run():
        raw=None
        try:
            raw,_=listener.accept();raw.settimeout(4)
            with ctx.wrap_socket(raw,server_side=True) as s:rows.append(handler(s))
        except BaseException as e:
            errors.append(e)
            if raw is not None:raw.close()
        finally:listener.close()
    t=threading.Thread(target=run);t.start()
    return port,t,errors,rows


def test_pinned_ca_cold_and_warm(cert,wire):
    port,t,errors,rows=server(cert,lambda s:[receive_one(s),receive_one(s)])
    stream,meta=connect('127.0.0.1',port,cafile=str(cert/'cert.pem'),server_hostname='localhost',timeout=4)
    with stream:
        a=send_one(stream,wire);b=send_one(stream,wire)
    t.join(5)
    assert not t.is_alive() and not errors
    assert a['payload_sha256']==hashlib.sha256(wire).hexdigest()==b['payload_sha256']
    assert meta['network_RTT_seconds'] is None and not a['semantic_authorization']
    assert meta['tls_version'] in ('TLSv1.2','TLSv1.3')


def test_wrong_hostname_is_rejected(cert):
    port,t,errors,rows=server(cert,lambda s:receive_one(s))
    with pytest.raises(ssl.SSLCertVerificationError):connect('127.0.0.1',port,cafile=str(cert/'cert.pem'),server_hostname='wrong.invalid',timeout=4)
    t.join(5);assert not rows


def test_untrusted_self_signed_is_rejected(cert):
    port,t,errors,rows=server(cert,lambda s:receive_one(s))
    with pytest.raises(ssl.SSLCertVerificationError):connect('127.0.0.1',port,timeout=4)
    t.join(5);assert not rows


def test_oversized_frame_rejected_before_body(cert):
    port,t,errors,rows=server(cert,lambda s:receive_one(s,limit=100))
    stream,_=connect('127.0.0.1',port,cafile=str(cert/'cert.pem'),timeout=4)
    with stream:stream.sendall(LENGTH.pack(101))
    t.join(5);assert len(errors)==1 and isinstance(errors[0],ValueError)


def test_corrupt_ack_not_success(cert,wire):
    def wrong(s):
        size=LENGTH.unpack(recv_exact(s,8))[0];recv_exact(s,size)
        ack=json.dumps({'status':'received','payload_sha256':'0'*64,'wire_bytes':size}).encode()
        s.sendall(LENGTH.pack(len(ack))+ack)
    port,t,errors,rows=server(cert,wrong)
    stream,_=connect('127.0.0.1',port,cafile=str(cert/'cert.pem'),timeout=4)
    with stream,pytest.raises(ValueError):send_one(stream,wire)
    t.join(5)


def test_truncated_frame():
    a,b=socket.socketpair()
    try:
        a.sendall(b'abc');a.shutdown(socket.SHUT_WR)
        with pytest.raises(ValueError):recv_exact(b,4)
    finally:a.close();b.close()

@pytest.mark.parametrize('host,port,timeout',[('',443,2),('localhost',0,2),('localhost',True,2),('localhost',443,float('inf')),('localhost',443,True)])
def test_invalid_connection_parameters(host,port,timeout):
    with pytest.raises(ValueError):connect(host,port,timeout=timeout)

@pytest.mark.parametrize('shape',['wrong_count','non_object'])
def test_ack_shape_and_count(cert,wire,shape):
    def wrong(s):
        size=LENGTH.unpack(recv_exact(s,8))[0];payload=recv_exact(s,size)
        obj={'status':'received','payload_sha256':hashlib.sha256(payload).hexdigest(),'wire_bytes':size,'decoded_packets':9999} if shape=='wrong_count' else []
        ack=json.dumps(obj).encode();s.sendall(LENGTH.pack(len(ack))+ack)
    port,t,errors,rows=server(cert,wrong)
    stream,_=connect('127.0.0.1',port,cafile=str(cert/'cert.pem'),timeout=4)
    with stream,pytest.raises(ValueError):send_one(stream,wire)
    t.join(5);assert not t.is_alive()
