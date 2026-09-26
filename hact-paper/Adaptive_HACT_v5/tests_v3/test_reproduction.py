import importlib.util
from pathlib import Path
import pytest
P=Path(__file__).resolve().parents[1]/'tools/reproduce.py'
spec=importlib.util.spec_from_file_location('isolated_reproduction',P)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


def test_new_destination_preserves_original_and_history(tmp_path,monkeypatch):
    source=tmp_path/'source';(source/'results/v3').mkdir(parents=True)
    (source/'results/v3/frozen.json').write_text('original')
    (source/'historical/results_v2').mkdir(parents=True)
    (source/'historical/results_v2/raw.json').write_text('historical')
    (source/'paper/generated').mkdir(parents=True)
    (source/'paper/generated/table.tex').write_text('old')
    monkeypatch.setattr(module,'ROOT',source)
    dest=module.prepare(tmp_path/'fresh')
    assert not (dest/'results/v3/frozen.json').exists()
    assert (source/'results/v3/frozen.json').read_text()=='original'
    assert (dest/'historical/results_v2/raw.json').read_text()=='historical'
    assert not (dest/'paper/generated/table.tex').exists()


def test_reproduction_refuses_existing_or_nested_destination(tmp_path,monkeypatch):
    monkeypatch.setattr(module,'ROOT',tmp_path)
    with pytest.raises(ValueError):module.prepare(tmp_path/'nested')
    with pytest.raises(ValueError):module.prepare(tmp_path)
