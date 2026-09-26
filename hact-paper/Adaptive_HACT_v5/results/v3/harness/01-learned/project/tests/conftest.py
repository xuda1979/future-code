import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import pytest


@pytest.fixture
def endpoint():
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_GET(self):
            if self.path == '/missing': status, body = 404, b'not found'
            elif self.path == '/malformed': status, body = 200, b'not json'
            elif self.path == '/array': status, body = 200, b'[1,2]'
            elif self.path == '/large': status, body = 200, b'x' * 4096
            else:
                status = 200
                n = int(self.path.strip('/') or '1')
                body = json.dumps({'event': f'e{n}', 'account': 'alice', 'delta': n}).encode()
            self.send_response(status)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
    thread.start()
    try: yield f'http://127.0.0.1:{server.server_port}'
    finally:
        server.shutdown(); server.server_close(); thread.join()
