from pathlib import Path
import hashlib,json,zipfile,subprocess
import pytest
from tools.hydrate_observations import hydrate,safe


def fixture(root, members=None):
    members={'results/v14/a.json':b'{"answer":42}\n'} if members is None else members
    archive=root/'payload.zip'
    with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
        for name,value in members.items():z.writestr(name,value)
    raw=archive.read_bytes();archive.unlink()
    parts=[]
    for i,offset in enumerate(range(0,len(raw),37)):
        p=root/f'data/part{i}';p.parent.mkdir(exist_ok=True);p.write_bytes(raw[offset:offset+37])
        parts.append({'path':str(p.relative_to(root)),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
    index={'schema':'hact-observation-archive-1','archive_sha256':hashlib.sha256(raw).hexdigest(),'parts':parts,
           'files':{n:{'bytes':len(v),'sha256':hashlib.sha256(v).hexdigest()} for n,v in members.items()}}
    (root/'OBSERVATION_ARCHIVE.json').write_text(json.dumps(index));return index


def test_restoration_is_exact_offline_and_idempotent(tmp_path):
    fixture(tmp_path)
    assert hydrate(tmp_path)['files_restored']==1
    assert (tmp_path/'results/v14/a.json').read_bytes()==b'{"answer":42}\n'
    assert hydrate(tmp_path)['files_already_matching']==1


@pytest.mark.parametrize('name',['../escape','/absolute','a/../escape','a\\b','./relative'])
def test_unsafe_paths_reject(tmp_path,name):
    with pytest.raises(ValueError):safe(tmp_path,name)


def test_changed_existing_data_is_never_overwritten(tmp_path):
    fixture(tmp_path);p=tmp_path/'results/v14/a.json';p.parent.mkdir(parents=True);p.write_text('changed')
    with pytest.raises(ValueError,match='refuse'):hydrate(tmp_path)
    assert p.read_text()=='changed'


def test_corrupt_part_and_missing_part_reject(tmp_path):
    index=fixture(tmp_path);p=tmp_path/index['parts'][0]['path'];p.write_bytes(b'wrong')
    with pytest.raises(ValueError,match='part'):hydrate(tmp_path)
    p.unlink()
    with pytest.raises(ValueError,match='part'):hydrate(tmp_path)


def test_symlink_member_or_parent_reject(tmp_path):
    fixture(tmp_path);(tmp_path/'target').mkdir();(tmp_path/'results').symlink_to(tmp_path/'target',target_is_directory=True)
    with pytest.raises(ValueError,match='symlink'):hydrate(tmp_path)


def test_wrong_inventory_or_content_hash_reject(tmp_path):
    index=fixture(tmp_path);index['files']['results/v14/a.json']['sha256']='0'*64
    (tmp_path/'OBSERVATION_ARCHIVE.json').write_text(json.dumps(index))
    with pytest.raises(ValueError,match='hash'):hydrate(tmp_path)
    assert not (tmp_path/'results/v14/a.json').exists()


def test_release_manifest_keeps_ignored_raw_bytes_and_refuses_rebaseline(tmp_path,monkeypatch):
    from tools import update_manifest
    fixture(tmp_path);hydrate(tmp_path)
    subprocess.run(['git','init','-q',str(tmp_path)],check=True)
    (tmp_path/'.gitignore').write_text('results/\n')
    (tmp_path/'RELEASE_MANIFEST.json').write_text('{}')
    (tmp_path/'RELEASE_FILES.txt').write_text('')
    monkeypatch.setattr(update_manifest,'ROOT',tmp_path)
    update_manifest.main()
    manifest=json.loads((tmp_path/'RELEASE_MANIFEST.json').read_text())
    assert manifest['files']['results/v14/a.json']==json.loads((tmp_path/'OBSERVATION_ARCHIVE.json').read_text())['files']['results/v14/a.json']
    (tmp_path/'results/v14/a.json').write_text('changed evidence')
    with pytest.raises(ValueError,match='refuse rebaselining'):update_manifest.main()
    (tmp_path/'results/v14/a.json').unlink()
    with pytest.raises(ValueError,match='missing'):update_manifest.main()
