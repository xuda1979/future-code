import math
import pytest
from experiments_v12.report import project, render
from experiments_v15.review_followups import cap64_replay, category, waves


def test_observer_table_pairs_disabled_ratio_with_disabled_times():
    data = project()
    text = render(data)
    assert 'Project & Counter & HACT32 & Off & On' in text
    for row in data['service']:
        off = row['states']['observer_disabled']
        assert math.isclose(off['hact_selected'] / off['counter'], off['ratio'])
    assert 'Pluggy & 23.0 & 37.1 & 1.61 & 1.45' in text
    assert 'ExceptionGroup & 20.3 & 39.0 & 1.92 & 1.43' in text


def test_cap64_replay_includes_all_seeds_and_losses():
    rows = cap64_replay()
    assert len(rows) == 30
    assert len({(r['project'], r['policy'], r['seed']) for r in rows}) == 30
    assert all(set(r['costs']) == {'historical', 'cap32', 'cap64', 'exchangeable'} for r in rows)


@pytest.mark.parametrize('filename,function,expected', [
    ('/usr/lib/python3.12/json/encoder.py', 'iterencode', 'json'),
    ('~', '<built-in method _hashlib.openssl_sha256>', 'hashing'),
    ('~', '<built-in method zlib.compress>', 'compression'),
    ('/repo/hact/certificates.py', 'refresh', 'kernel_capsules'),
    ('/repo/hact/tree.py', 'walk', 'tree'),
])
def test_profile_buckets_are_disjoint_by_construction(filename, function, expected):
    assert category(filename, function) == expected


def test_complete_registry_required_for_new_sparse_replay():
    with pytest.raises(ValueError):
        waves({'registry': ['a', 'b'], 'executed': ['a', 'a']}, ('a', 'b'))
