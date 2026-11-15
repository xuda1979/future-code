"""Real loopback proxy requests; no external providers or credentials."""
import concurrent.futures
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import ssl
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('endpoint_proxy', Path(__file__).resolve().parents[2] / 'future_huanxin_future_proxy.py')
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


class Upstream(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.receipts.append((self.path, self.headers.get('Authorization'), body))
        if self.headers.get('Authorization') == 'Bearer rejected-test-key':
            self.send_response(401)
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"bad key","type":"authentication_error"}}')
            return
        self.send_response(200)
        if body.get('stream'):
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            chunks = [
                {'choices': [{'delta': {'content': 'ok'}, 'finish_reason': None}]},
                {'choices': [{'delta': {}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 2, 'completion_tokens': 1}},
            ]
            for chunk in chunks:
                self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
            self.wfile.write(b'data: [DONE]\n\n')
        else:
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'choices': [{'message': {'content': 'ok'}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 2, 'completion_tokens': 1}}).encode())


class EndpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'FUTURE_CONFIG_DIR': self.temp.name, 'HUANXIN_GLM52_RETRIES': '1', 'HUANXIN_UPSTREAM_MIN_SPACING': '0'})
        self.env.start()
        self.servers = []
        self.first = self.start(Upstream)
        self.second = self.start(Upstream)
        self.bridge = self.start(proxy.Handler)
        self.bridge.upstream_url = self.url(self.first) + '/default/v1/chat/completions'
        self.bridge.upstream_token = 'default-test-key'
        self.bridge.model_name = 'default-model'
        self.bridge.appcode = 'default-appcode'
        self.bridge.max_input_chars = 24000
        self.bridge.insecure = False
        self.bridge.verify_context = ssl.create_default_context()
        self.bridge.insecure_context = ssl._create_unverified_context()

    def start(self, handler):
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        server.receipts = []
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        thread.start()
        self.servers.append((server, thread))
        return server

    def tearDown(self):
        for server, thread in self.servers:
            server.shutdown()
            server.server_close()
            thread.join(2)
        self.env.stop()
        self.temp.cleanup()

    def url(self, server):
        return 'http://127.0.0.1:' + str(server.server_port)

    def save(self, model, upstream, key='profile-test-key', suffix='/v1'):
        directory = Path(self.temp.name) / 'model-endpoints'
        directory.mkdir(exist_ok=True)
        path = directory / (hashlib.sha256(model.encode()).hexdigest() + '.json')
        # Same profile format/hash produced by the TS local command.
        path.write_text(json.dumps({'version': 1, 'model': model, 'baseUrl': self.url(upstream) + suffix, 'apiKey': key, 'protocol': 'openai'}))
        return path

    def request(self, model, stream=False):
        body = {'model': model, 'stream': stream, 'max_tokens': 1, 'messages': [{'role': 'user', 'content': 'Hi'}]}
        request = urllib.request.Request(self.url(self.bridge) + '/v1/messages', data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.read().decode()

    def test_saved_routes_reload_without_proxy_restart_and_preserve_case(self):
        self.save('Example/Model-A', self.first)
        self.assertEqual(json.loads(self.request('Example/Model-A'))['content'][0]['text'], 'ok')
        path, auth, body = self.first.receipts[-1]
        self.assertEqual((path, auth, body['model']), ('/v1/chat/completions', 'Bearer profile-test-key', 'Example/Model-A'))
        self.save('Example/Model-A', self.second, 'updated-test-key', '/gateway/v1')
        self.request('Example/Model-A')
        self.assertEqual(self.second.receipts[-1][:2], ('/gateway/v1/chat/completions', 'Bearer updated-test-key'))
        self.assertEqual(self.bridge.upstream_token, 'default-test-key')
        self.assertEqual(self.bridge.appcode, 'default-appcode')

    def test_parallel_and_streaming_requests_keep_each_route_and_key(self):
        self.save('Model-A', self.first, 'test-key-A')
        self.save('Model-B', self.second, 'test-key-B')
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda pair: self.request(*pair), [('Model-A', True), ('Model-B', True), ('Model-A', False), ('Model-B', False)]))
        self.assertIn('message_stop', results[0])
        self.assertIn('ok', results[1])
        for server, model, key in [(self.first, 'Model-A', 'test-key-A'), (self.second, 'Model-B', 'test-key-B')]:
            self.assertEqual(len(server.receipts), 2)
            for path, auth, body in server.receipts:
                self.assertEqual((path, auth, body['model']), ('/v1/chat/completions', 'Bearer ' + key, model))

    def test_bad_profile_fails_closed_without_default_provider_fallback(self):
        path = self.save('Model-A', self.second)
        path.write_text('{"apiKey":"secret-invalid-json"')
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.request('Model-A')
        self.assertEqual(caught.exception.code, 400)
        self.assertNotIn('secret', caught.exception.read().decode())
        self.assertEqual(self.first.receipts + self.second.receipts, [])

    def test_bad_credentials_are_rejected_and_unknown_models_keep_default_routing(self):
        self.save('Model-A', self.second, 'rejected-test-key')
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.request('Model-A')
        self.assertEqual(caught.exception.code, 401)
        self.request('unconfigured')
        self.assertEqual(self.first.receipts[-1][0], '/default/v1/chat/completions')
        self.assertEqual(self.first.receipts[-1][1], 'default-test-key')

    def test_url_forms_do_not_duplicate_v1_and_health_advertises_capability(self):
        for suffix in ['', '/v1', '/v1/chat/completions']:
            self.save('Model-A', self.second, suffix=suffix)
            self.request('Model-A')
            self.assertEqual(self.second.receipts[-1][0], '/v1/chat/completions')
        self.save('Model-A', self.second, suffix='/api/paas/v4')
        self.request('Model-A')
        self.assertEqual(self.second.receipts[-1][0], '/api/paas/v4/chat/completions')
        with urllib.request.urlopen(self.url(self.bridge) + '/health', timeout=2) as response:
            self.assertEqual(json.load(response)['model_endpoints'], 1)


if __name__ == '__main__':
    unittest.main()
