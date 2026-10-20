#!/usr/bin/env python3
"""Explicitly refresh the current source/PDF manifest; preserve v5's manifest."""
from pathlib import Path
import hashlib
import json
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def main():
    current = ROOT / 'RELEASE_MANIFEST.json'
    archived = ROOT / 'historical/v5_release_manifest.json'
    if not archived.exists():
        archived.parent.mkdir(parents=True, exist_ok=True)
        archived.write_bytes(current.read_bytes())
    listing = subprocess.check_output(
        ['git', '-C', str(ROOT), 'ls-files', '-c', '-o', '--exclude-standard', '-z', '--', '.'])
    files = sorted({name.decode() for name in listing.split(b'\0') if name
                    and name.decode() != 'RELEASE_MANIFEST.json'})
    if any(not (ROOT / name).is_file() for name in files):
        raise ValueError('tracked source missing; refuse incomplete manifest')
    (ROOT / 'RELEASE_FILES.txt').write_text('\n'.join(files) + '\n')
    manifest = {'schema': 'hact-release-manifest-1', 'release': '5.0.0',
                'manuscript': '10.0',
                'boundary': 'current source/PDF byte integrity; empirical records retain original versions; no digital signature',
                'files': {}}
    for name in files:
        raw = (ROOT / name).read_bytes()
        manifest['files'][name] = {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
    current.write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    print(json.dumps({'files': len(files), 'manuscript': manifest['manuscript']}))


if __name__ == '__main__':
    main()
