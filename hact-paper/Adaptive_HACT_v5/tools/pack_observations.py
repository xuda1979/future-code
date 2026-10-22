#!/usr/bin/env python3
"""Explicit one-time, lossless research-data packaging; never deletes inputs."""
from pathlib import Path
import hashlib,json,subprocess,tempfile,zipfile

ROOT=Path(__file__).resolve().parents[1]
PREFIXES=('results/v11/','results/v12/','results/v13/','results/v14/')
PART_BYTES=576*1024


def main():
    destination=ROOT/'data/observations'
    if destination.exists() or (ROOT/'OBSERVATION_ARCHIVE.json').exists():
        raise ValueError('refuse to overwrite observation transport')
    # Hydrated observations are intentionally ignored by Git. Read the
    # explicit result prefixes, including ignored new versioned records.
    listing=subprocess.check_output(['git','-C',str(ROOT),'ls-files','-c','-o','-z','--',*PREFIXES])
    names=sorted({x.decode() for x in listing.split(b'\0') if x and x.decode().startswith(PREFIXES)
                  and '/__pycache__/' not in x.decode() and '.pytest_evidence.json.' not in x.decode()})
    files={name:{'bytes':(ROOT/name).stat().st_size,'sha256':hashlib.sha256((ROOT/name).read_bytes()).hexdigest()} for name in names}
    destination.mkdir(parents=True)
    with tempfile.TemporaryDirectory(prefix='hact-pack-') as temporary:
        archive=Path(temporary)/'observations.zip'
        with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
            for name in names:
                info=zipfile.ZipInfo(name,date_time=(2026,10,22,0,0,0))
                info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644<<16
                z.writestr(info,(ROOT/name).read_bytes(),compresslevel=6)
        raw=archive.read_bytes();parts=[]
        for start in range(0,len(raw),PART_BYTES):
            payload=raw[start:start+PART_BYTES]
            path=destination/f'observations.zip.part{len(parts):04d}';path.write_bytes(payload)
            parts.append({'path':str(path.relative_to(ROOT)),'bytes':len(payload),'sha256':hashlib.sha256(payload).hexdigest()})
    index={'schema':'hact-observation-archive-1','archive_sha256':hashlib.sha256(raw).hexdigest(),
           'archive_bytes':len(raw),'parts':parts,'files':files,
           'scope':'lossless offline transport of complete versioned observations; no result rewriting or omitted outcomes'}
    (ROOT/'OBSERVATION_ARCHIVE.json').write_text(json.dumps(index,indent=2,sort_keys=True)+'\n')
    print(json.dumps({'status':'PASS','observation_files':len(files),'archive_bytes':len(raw),'parts':len(parts)}))


if __name__=='__main__':main()
