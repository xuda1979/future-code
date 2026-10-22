#!/usr/bin/env python3
"""Restore exact versioned observations from an offline lossless archive.

All paths/sizes/part hashes are validated before extraction. Existing matching
files are retained; different files or symlink paths reject. Each missing file
is hash-checked before an atomic rename, so an interrupted hydration is resumable.
This prepares inputs; the independent audits and release-manifest gate still run.
"""
from pathlib import Path, PurePosixPath
import argparse,hashlib,json,tempfile,zipfile,os

ROOT=Path(__file__).resolve().parents[1]
INDEX='OBSERVATION_ARCHIVE.json'
MAX_TOTAL=1024**3


def sha(path):
    value=hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda:stream.read(1024**2),b''):value.update(block)
    return value.hexdigest()


def safe(root, name):
    if not isinstance(name,str) or '\\' in name or not name:
        raise ValueError('invalid archive path')
    parts=PurePosixPath(name)
    if parts.is_absolute() or any(x in ('..','.') for x in parts.parts) or str(parts)!=name:
        raise ValueError('unsafe archive path')
    path=root/name
    for part in [path,*path.parents]:
        if part==root:break
        if part.is_symlink():raise ValueError('symlink in observation path')
    if not path.resolve().is_relative_to(root.resolve()):raise ValueError('observation escaped root')
    return path


def hydrate(root=ROOT, *, require_index=False):
    root=Path(root).resolve()
    index_path=root/INDEX
    if not index_path.exists():
        if require_index:
            raise ValueError('required observation archive index is missing: '+INDEX)
        return {'status':'NOT_REQUIRED','files_restored':0,'scope':'no packed observation index'}
    index=json.loads(index_path.read_text())
    if index.get('schema')!='hact-observation-archive-1':raise ValueError('invalid observation index schema')
    files=index['files'];parts=index['parts']
    if not files or not parts or sum(v['bytes'] for v in files.values())>MAX_TOTAL:
        raise ValueError('invalid or excessive observation inventory')
    for name,value in files.items():
        safe(root,name)
        if type(value['bytes']) is not int or value['bytes']<0 or not isinstance(value['sha256'],str) or len(value['sha256'])!=64:
            raise ValueError('invalid observation metadata')
    if len({p['path'] for p in parts})!=len(parts):raise ValueError('duplicate archive part')
    for item in parts:
        path=safe(root,item['path'])
        if not path.is_file() or path.stat().st_size!=item['bytes'] or sha(path)!=item['sha256']:
            raise ValueError('observation archive part missing or changed')
    restored=retained=0
    with tempfile.TemporaryDirectory(prefix='hact-observations-') as temporary:
        archive=Path(temporary)/'observations.zip'
        with archive.open('wb') as target:
            for item in parts:
                with (root/item['path']).open('rb') as stream:
                    for block in iter(lambda:stream.read(1024**2),b''):target.write(block)
        if sha(archive)!=index['archive_sha256']:raise ValueError('assembled observation archive hash mismatch')
        with zipfile.ZipFile(archive) as source:
            entries=source.infolist()
            if len(entries)!=len(files) or {x.filename for x in entries}!=set(files):
                raise ValueError('observation archive members differ from declared inventory')
            for entry in entries:
                if entry.file_size!=files[entry.filename]['bytes'] or (entry.external_attr>>16)&0o170000==0o120000:
                    raise ValueError('invalid observation archive size/type')
            # Refuse every existing mismatch before creating any missing file.
            for name,value in files.items():
                path=safe(root,name)
                if path.exists() and (not path.is_file() or path.stat().st_size!=value['bytes'] or sha(path)!=value['sha256']):
                    raise ValueError('refuse to overwrite different observation: '+name)
            for name,value in files.items():
                path=safe(root,name)
                if path.exists():retained+=1;continue
                path.parent.mkdir(parents=True,exist_ok=True)
                handle,temp=tempfile.mkstemp(prefix='.hact-observation-',dir=path.parent)
                temp=Path(temp)
                try:
                    digest=hashlib.sha256();total=0
                    with os.fdopen(handle,'wb') as target,source.open(name) as stream:
                        for block in iter(lambda:stream.read(1024**2),b''):
                            total+=len(block)
                            if total>value['bytes']:raise ValueError('observation exceeds declared size')
                            digest.update(block);target.write(block)
                    if total!=value['bytes'] or digest.hexdigest()!=value['sha256']:
                        raise ValueError('restored observation hash mismatch')
                    os.replace(temp,path);restored+=1
                finally:
                    if temp.exists():temp.unlink()
    return {'status':'PASS','files_restored':restored,'files_already_matching':retained,
            'scope':'exact offline observation restoration; independent audit/manifest checks remain required'}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--require-index',action='store_true',
                        help='reject an incomplete evidence checkout before testing')
    args=parser.parse_args()
    print(json.dumps(hydrate(require_index=args.require_index)))
