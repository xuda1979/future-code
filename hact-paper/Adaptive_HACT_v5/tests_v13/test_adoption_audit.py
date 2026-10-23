from copy import deepcopy
import json
from pathlib import Path

import pytest

from audit.check_v13 import verify

ROOT = Path(__file__).resolve().parents[1]


def observation():
    return json.loads((ROOT/'results/v13/adoption.json').read_text())


def test_retained_independent_audit():
    assert verify(observation())['public_admitted_shifts'] == 30


@pytest.mark.parametrize('kind', ['range', 'formula', 'strictness', 'law', 'shift', 'public', 'exclusion', 'seed', 'source'])
def test_tampering_fails_closed(kind):
    data = deepcopy(observation())
    if kind == 'range':
        data['synthetic']['envelope']['lower'] += 1
    elif kind == 'formula':
        data['synthetic']['laws'][0]['rows'][0]['paired_lower'] = '0'
    elif kind == 'strictness':
        row = data['synthetic']['laws'][0]['rows'][0]
        row['paired_adopt'] = not row['paired_adopt']
    elif kind == 'law':
        data['synthetic']['laws'][1]['exact_mean_bytes'] = '32'
    elif kind == 'shift':
        data['synthetic']['api_shift_0_01']['status'] = 'CONDITIONAL_BENEFIT'
    elif kind == 'public':
        data['public_diagnostics'][0]['status'] = 'CONDITIONAL_BENEFIT'
    elif kind == 'exclusion':
        data['public_diagnostics'].pop(2)
    elif kind == 'seed':
        data['synthetic']['laws'][0]['rows'][0]['seed'] = 1
    elif kind == 'source':
        data['inputs']['ichact/adoption.py'] = '0'*64
    with pytest.raises(ValueError):
        verify(data)
