from itertools import permutations
import pytest

from ichact.sparse import sparse_order, touched_cost, select_sparse
from ichact.practical import balanced_layout


def test_order_is_deterministic_with_isolated_ids_and_input_permutations():
    waves = [[3, 0, 4], [1, 2], [4, 3]]
    expected, info = sparse_order([waves], 7)
    for reordered in permutations(waves):
        actual, _ = sparse_order([[list(reversed(w)) for w in reordered]], 7)
        assert actual == expected
    assert sorted(expected) == list(range(7))
    assert info['positive_edges'] == 4
    assert info['components'] == 4
    assert info['dense_affinity_allocated'] is False


@pytest.mark.parametrize('n', [1, 2, 7, 9, 65])
def test_dirty_ancestor_cost_matches_full_independent_node_walk(n):
    ids = tuple(map(str, range(n)))
    for order in (tuple(range(n)), tuple(reversed(range(n)))):
        layout = balanced_layout(ids, order)
        waves = [list(range(i, min(n, i + 3))) for i in range(0, n, 3)]
        episodes = [waves, [[], waves[0], waves[0]], [[]]]
        assert touched_cost(layout, episodes) == [layout.cost(ep) for ep in episodes]


def test_validation_tie_retains_incumbent_and_rejects_bad_inputs():
    ids = tuple(map(str, range(9)))
    train = [[[0, 8], [1, 7], [2, 6], [3, 5], [4]]]
    selected, info = select_sparse(ids, train, [[list(range(9))]])
    assert info['selected'] == 'original'
    assert selected == balanced_layout(ids)
    with pytest.raises(MemoryError):
        sparse_order([[[0, 1, 2]]], 3, max_edges=2)
    with pytest.raises(ValueError):
        sparse_order([[[0, 1, 2]]], 3, max_wave_width=2)
    with pytest.raises(ValueError):
        sparse_order([[[True]]], 2)
    with pytest.raises(ValueError):
        sparse_order([], 2)
    with pytest.raises(ValueError):
        touched_cost(selected, [[[9]]])
