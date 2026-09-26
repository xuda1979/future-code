import json
from urllib.error import HTTPError
import pytest
from transport import fetch_json


@pytest.mark.parametrize('n',range(1,9))
def test_read_actual_http(endpoint,n):
    assert fetch_json(endpoint+f'/{n}')['delta']==n


@pytest.mark.parametrize('path',['malformed','array','large'])
def test_invalid_payload(endpoint,path):
    with pytest.raises((ValueError,json.JSONDecodeError)): fetch_json(endpoint+'/'+path)


def test_http_error(endpoint):
    with pytest.raises(HTTPError):fetch_json(endpoint+'/missing')


@pytest.mark.parametrize('url',['file:///etc/hosts','ftp://localhost/test'])
def test_reject_other_protocol(url):
    with pytest.raises(ValueError):fetch_json(url)


@pytest.mark.parametrize('limit',[0,-1])
def test_bad_limit(endpoint,limit):
    with pytest.raises(ValueError):fetch_json(endpoint+'/1',limit)
