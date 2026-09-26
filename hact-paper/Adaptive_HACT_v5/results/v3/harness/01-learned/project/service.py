from ledger import apply
from transport import fetch_json


def ingest(path, url):
    payload = fetch_json(url)
    return apply(path, payload['event'], payload['account'], payload['delta'])
