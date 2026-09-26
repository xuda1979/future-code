import copy,importlib.util,json
from pathlib import Path
import pytest
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('v4_independent_auditor',ROOT/'audit/check_v4.py')
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)


def first():return json.loads((ROOT/'results/v4/exposure.json').read_text())[0]

def test_real_view_audits():a.validate_view(first())

@pytest.mark.parametrize('field',['packet_bytes','packet_count','diagnostic_pages','root_prompt_bytes'])
def test_auditor_rejects_altered_measurement(field):
    row=first();row[field]+=1
    with pytest.raises(AssertionError):a.validate_view(row)

def test_auditor_rejects_compressed_byte_claim():
    row=first();row['wire_bytes']['batch_zlib']+=1
    with pytest.raises(AssertionError):a.validate_view(row)

def test_version_agrees_with_packaging():
    import tomllib,ichact
    metadata=tomllib.loads((ROOT/'pyproject.toml').read_text())
    assert metadata['project']['version']==ichact.__version__=='5.0.0'


def summary_inputs():
    out=ROOT/'results/v4'
    return (json.loads((out/'summary.json').read_text()),json.loads((out/'exposure.json').read_text()),
            [json.loads(x) for x in (out/'transport.jsonl').read_text().splitlines()],
            json.loads((out/'scaling.json').read_text()))

def test_independent_summary_audit():
    assert a.validate_summary(*summary_inputs())>=100

@pytest.mark.parametrize('group,field',[('projects','pairs'),('timing','fixed_seconds_per_12_exports'),('scaling','blocked_seconds_median')])
def test_independent_audit_rejects_bad_summary(group,field):
    args=list(summary_inputs())
    if group=='projects':args[0][group][0]['bytes']['compact']['fixed']+=10
    else:args[0][group][0][field]+=10
    with pytest.raises(AssertionError):a.validate_summary(*args)
