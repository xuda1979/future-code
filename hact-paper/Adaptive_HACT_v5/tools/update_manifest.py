#!/usr/bin/env python3
"""Explicitly refresh the current source/PDF manifest; preserve v5's manifest."""
from pathlib import Path
import hashlib
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


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
    # Packed observations remain first-class release bytes after restoration.
    # Git ignores their hydrated copies; the explicit hash-bound inventory
    # prevents a publication snapshot from silently dropping raw evidence.
    index = ROOT / 'OBSERVATION_ARCHIVE.json'
    observations = json.loads(index.read_text())['files'] if index.exists() else {}
    from tools.hydrate_observations import safe
    for name in observations:
        safe(ROOT, name)
    files = sorted(set(files) | set(observations))
    if any(not (ROOT / name).is_file() for name in files):
        raise ValueError('tracked source missing; refuse incomplete manifest')
    (ROOT / 'RELEASE_FILES.txt').write_text('\n'.join(files) + '\n')
    manifest = {'schema': 'hact-release-manifest-1', 'release': '5.0.0',
                'manuscript': '14.0',
                'boundary': 'current source/PDF byte integrity; empirical records retain original versions; no digital signature',
                'files': {}}
    for name in files:
        raw = (ROOT / name).read_bytes()
        metadata = {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
        if name in observations and metadata != observations[name]:
            raise ValueError('packed observation changed; refuse rebaselining: ' + name)
        manifest['files'][name] = metadata
    current.write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    print(json.dumps({'files': len(files), 'manuscript': manifest['manuscript']}))


if __name__ == '__main__':
    main()
