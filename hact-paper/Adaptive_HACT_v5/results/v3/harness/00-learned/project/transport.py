"""Bounded HTTP JSON reader used by a local integration test service."""
import json
from urllib.request import urlopen
from urllib.parse import urlsplit


def fetch_json(url, max_bytes=2048, timeout=1):
    if urlsplit(url).scheme not in {'http', 'https'}:
        raise ValueError('HTTP(S) required')
    if type(max_bytes) is not int or max_bytes < 1:
        raise ValueError('positive byte limit required')
    with urlopen(url, timeout=timeout) as response:
        body = response.read(max_bytes + 1)
    if len(body) > max_bytes:
        raise ValueError('response exceeds limit')
    result = json.loads(body)
    if not isinstance(result, dict):
        raise ValueError('JSON object required')
    return result
