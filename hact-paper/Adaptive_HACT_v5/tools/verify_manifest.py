#!/usr/bin/env python3
"""Verify exact released bytes against RELEASE_MANIFEST.json (no network)."""
from pathlib import Path
import hashlib,json
ROOT=Path(__file__).resolve().parents[1]


def main():
    manifest=json.loads((ROOT/'RELEASE_MANIFEST.json').read_text());checked=0
    for relative,expected in manifest['files'].items():
        path=ROOT/relative
        if not path.resolve().is_relative_to(ROOT) or not path.is_file():raise SystemExit('missing/unsafe: '+relative)
        raw=path.read_bytes()
        if len(raw)!=expected['bytes'] or hashlib.sha256(raw).hexdigest()!=expected['sha256']:raise SystemExit('mismatch: '+relative)
        checked+=1
    print(json.dumps({'verdict':'PASS','files_verified':checked,'scope':'manifest-listed files; manifest is not a digital signature'}))
if __name__=='__main__':main()
