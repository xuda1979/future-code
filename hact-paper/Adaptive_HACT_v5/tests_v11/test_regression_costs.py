import copy
import pytest
from experiments_v11.regression_costs import price_raw


def example():
    leaf = lambda i: {'lo': i, 'hi': i, 'children': []}
    return {'registry': ['a', 'b', 'c'], 'order': [0, 1, 2],
            'model': {'header': 512, 'card': 320, 'cap': 3072},
            'tree': {'lo': 0, 'hi': 2, 'children': [leaf(0),
                {'lo': 1, 'hi': 2, 'children': [leaf(1), leaf(2)]}]}}


def test_packet_union_prices_each_touched_ancestor_once():
    result = price_raw(example(), ['a', 'b', 'c'])
    assert result == {'construction_bytes': 2304, 'refresh_bytes': 2304,
                      'total_bytes': 4608, 'waves': 1}
    assert price_raw(example(), ['a'])['total_bytes'] == 3456
    assert price_raw(example(), [])['total_bytes'] == 2304


@pytest.mark.parametrize('corrupt', ['order', 'coverage', 'foreign', 'duplicate'])
def test_bad_semantic_or_tree_contract_is_rejected(corrupt):
    layout = copy.deepcopy(example()); completed = ['a']
    if corrupt == 'order': layout['order'] = [0, 0, 2]
    if corrupt == 'coverage': layout['tree']['children'][1]['lo'] = 0
    if corrupt == 'foreign': completed = ['other']
    if corrupt == 'duplicate': completed = ['a', 'a']
    with pytest.raises(ValueError):
        price_raw(layout, completed)
