from copy import deepcopy
import json
from pathlib import Path
import pytest
from audit.check_v15 import verify

ROOT = Path(__file__).resolve().parents[1]


def data():
    return [json.loads((ROOT / 'results/v15' / name).read_text())
            for name in ('cap64_dispatch.json', 'cpu_profile.json', 'sparse_packaging.json')]


def test_retained_followups_account_for_all_cases():
    assert verify(*data())['profile_answers'] == 840


@pytest.mark.parametrize('kind', ['missing_shift', 'lost_negative', 'profile_total', 'overlap',
                                 'missing_case', 'answer', 'registry', 'resource', 'heldout'])
def test_followup_corruptions_are_rejected(kind):
    dispatch, cpu, sparse = deepcopy(data())
    if kind == 'missing_shift': dispatch['rows'].pop()
    elif kind == 'lost_negative':
        r = next(r for r in dispatch['rows'] if r['policy'] == 'items')
        r['costs']['cap64'] = r['costs']['exchangeable'] - 1
    elif kind == 'profile_total': cpu['rows'][0]['exclusive_total_seconds'] += 1
    elif kind == 'overlap': cpu['rows'][0]['exclusive_seconds_by_category']['json'] += 1
    elif kind == 'missing_case': cpu['rows'].pop()
    elif kind == 'answer': cpu['rows'][0]['answer_signatures'][0]['raw_bytes'] += 1
    elif kind == 'registry': sparse['selected_order'][0] = sparse['selected_order'][1]
    elif kind == 'resource': sparse['process_peak_rss_bytes'] = 2 * 1024**3 + 1
    elif kind == 'heldout': sparse['holdouts'][0]['selected_padded_bytes'] -= 1
    with pytest.raises(ValueError): verify(dispatch, cpu, sparse)
