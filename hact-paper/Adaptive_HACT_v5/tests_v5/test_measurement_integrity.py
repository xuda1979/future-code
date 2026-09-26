import json,copy
from pathlib import Path
import pytest
from experiments_v5.planning import paired_totals
ROOT=Path(__file__).resolve().parents[1]


def test_actual_aliases_require_nonempty_paired_groups():
    rows=json.loads((ROOT/'results/v4/exposure.json').read_text())
    costs=paired_totals(rows,'batch_zlib')
    assert 0<costs['cluster']<costs['fixed8']
    # Regression: an unobserved name previously led sum([]) to a false zero.
    broken=copy.deepcopy(rows)
    for r in broken:
        if r['method']=='cluster':r['method']='learned'
    with pytest.raises(ValueError):paired_totals(broken,'batch_zlib')

@pytest.mark.parametrize('kind',['missing','duplicate','zero'])
def test_bad_pair_fail_closed(kind):
    rows=json.loads((ROOT/'results/v4/exposure.json').read_text())
    if kind=='missing':rows.pop()
    if kind=='duplicate':rows.append(rows[0])
    if kind=='zero':rows[0]['wire_bytes']['compact']=0
    with pytest.raises(ValueError):paired_totals(rows,'compact')
