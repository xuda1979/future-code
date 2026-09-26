"""Content identities for local immutable snapshots (not a sandbox)."""
from __future__ import annotations
import hashlib
import importlib.metadata
import json
from pathlib import Path
import platform

IGNORED = {'__pycache__', '.pytest_cache', '.git', '.future-code', '.ai-loop'}

def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def canonical(value) -> str:
    return sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode())

def source_manifest(root: Path) -> dict[str, str]:
    root = root.resolve(); result = {}
    for path in sorted(root.rglob('*')):
        rel = path.relative_to(root)
        if any(x in IGNORED for x in rel.parts) or path.suffix == '.pyc':
            continue
        if path.is_symlink():
            raise ValueError('snapshot cannot contain symbolic links')
        if path.is_file():
            result[rel.as_posix()] = sha256(path.read_bytes())
    if not result:
        raise ValueError('empty snapshot')
    return result

def environment_identity():
    packages = {d.metadata['Name'].lower(): d.version for d in importlib.metadata.distributions() if d.metadata.get('Name')}
    return {'python': platform.python_version(), 'platform': platform.platform(), 'packages': dict(sorted(packages.items()))}

def checker_identity():
    base = Path(__file__).parent
    return canonical({p.name: sha256(p.read_bytes()) for p in sorted(base.glob('*.py'))})
