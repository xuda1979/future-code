import importlib.util
import json
from pathlib import Path
import zipfile
import pytest

SPEC = importlib.util.spec_from_file_location("release", Path(__file__).parents[1] / "scripts/release.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


def tree(root):
    (root / 'src/future_code').mkdir(parents=True)
    (root / 'src/future_code/a.py').write_text('VALUE = 1\n')
    (root / 'README.md').write_text('fixture\n')
    (root / 'deepseek.env').write_text('NEVER_PACKAGE_THIS=fixture\n')
    (root / 'src/__pycache__').mkdir()
    (root / 'src/__pycache__/cached.pyc').write_bytes(b'cache')


def test_frozen_release_reproducible_and_verifiable(tmp_path):
    root=tmp_path/'source';root.mkdir();tree(root)
    file_list=root/'RELEASE-FILES.txt'
    release.freeze(root,file_list)
    first=release.build(root,file_list,tmp_path/'first.zip')
    second=release.build(root,file_list,tmp_path/'second.zip')
    assert first['zip_sha256'] == second['zip_sha256']
    assert release.verify(root,root/release.MANIFEST)['verdict']=='PASS'
    with zipfile.ZipFile(tmp_path/'first.zip') as archive:
        assert not any('deepseek.env' in name or '__pycache__' in name for name in archive.namelist())
        archive.extractall(tmp_path/'extract')
    extracted=tmp_path/'extract/future-code-control-1.2.0'
    assert release.verify(extracted,extracted/release.MANIFEST)['verdict']=='PASS'
    (extracted/'src/future_code/a.py').write_text('VALUE = 2\n')
    with pytest.raises(ValueError,match='mismatch'):
        release.verify(extracted,extracted/release.MANIFEST)


@pytest.mark.parametrize('value',['../outside.py','/root/a','a/../b','a\\b','a:b','a//b'])
def test_manifest_paths_fail_closed(value):
    with pytest.raises(ValueError):release.relative(value)


def test_unlisted_source_rejected(tmp_path):
    tree(tmp_path);release.freeze(tmp_path,tmp_path/'RELEASE-FILES.txt')
    release.build(tmp_path,tmp_path/'RELEASE-FILES.txt',tmp_path/'file.zip')
    (tmp_path/'src/future_code/unlisted.py').write_text('bad')
    with pytest.raises(ValueError,match='Unexpected'):
        release.verify(tmp_path,tmp_path/release.MANIFEST)


@pytest.mark.parametrize('path', ['examples/.future-code/state.db', 'src/.env.production', 'evidence/.ssh/id_rsa', 'docs/.remember/log.txt'])
def test_nested_runtime_and_secret_paths_excluded(path):
    assert not release.eligible(path)
