from dataclasses import replace
from decimal import Decimal, localcontext
from itertools import permutations

import pytest

from experiments_v13.adoption_study import from_literal, layouts, literal_score, episode
from experiments_v11.strict_partition_witness import literal_trees, set_partitions
from ichact.adoption import AdoptionPlan, assess_adoption, difference_envelope, paired_savings, summarize_calibration
from ichact.layout import Layout
from hact.tree import CostModel


def plan(**changes):
    base, candidate = layouts()
    return replace(AdoptionPlan(base, (candidate,), 6, 3, '0.05', '0', 1000, (0,)), **changes)


GOOD = ((0, 1, 2, 3), (4,), (5,))
BAD = ((0, 1), (2, 3, 4), (5,))


def advice(p, observations):
    return assess_adoption(p, observations, frozen_plan_digest=p.uid,
                           sampling_justification='unit-test synthetic independent calibration assumption')


def test_cancellation_and_complete_root_bounds():
    p = plan()
    bound = difference_envelope(p.incumbent, p.candidates[0], max_wave_width=6, wave_count=3)
    assert (bound['lower'], bound['upper'], bound['width'], bound['whole_cost_width']) == (-3328, 256, 3584, 22784)
    assert len(bound['terms']) == 2
    root = next(x for x in bound['terms'] if x['coverage'] == 63)
    assert root['hit_lower'] == root['hit_upper'] == 3


def test_exhaustive_small_support_and_display_permutations():
    # Independent literal traversal checks every four-leaf hierarchy, all
    # complete partitions, every feasible (q,w), and all leaf permutations.
    trees = literal_trees(tuple(range(4)))
    base = from_literal(tuple(range(4)), 4)
    for tree in trees:
        candidate = from_literal(tree, 4)
        for order in permutations(candidate.order):
            changed = Layout(candidate.registry, order, candidate.tree)
            for q in range(1, 5):
                for w in range(1, 5):
                    partitions = [episode(x, 4) for x in set_partitions(15)
                                  if len(x) == q and max(y.bit_count() for y in x) <= w]
                    if not partitions:
                        continue
                    p = AdoptionPlan(base, (changed,), w, q, '0.05', '0', 1, (0,))
                    bound = difference_envelope(base, changed, max_wave_width=w, wave_count=q)
                    for waves, value in zip(partitions, paired_savings(p, partitions)[0]):
                        assert value == literal_score(base.to_dict(), waves) - literal_score(changed.to_dict(), waves)
                        assert bound['lower'] <= value <= bound['upper']


@pytest.mark.parametrize('observations', [
    (), ((),), (((0, 1, 2), (3, 4), (4, 5)),),
    (((0, 1, 2), (3, 4), ()),), (((0, 1, 2), (3, 4), (True,)),),
    (((0, 1, 2), (3, 4), (6,)),), (((0, 1, 2), (3, 4)),),
    (((0, 1, 2), (3, 4), ('5',)),),
])
def test_malformed_epochs_reject(observations):
    with pytest.raises(ValueError):
        advice(plan(), observations)


def test_incomplete_epoch_is_not_fabricated_as_a_complete_sample():
    with pytest.raises(ValueError, match='incomplete'):
        advice(plan(), (((0,), (1,), (2,)),))


@pytest.mark.parametrize('changes', [
    {'delta': 'nan'}, {'delta': '0'}, {'delta': '1'}, {'delta': True},
    {'shift_radius': '-0.1'}, {'shift_radius': '1.1'}, {'shift_radius': 'inf'},
    {'horizon': 0}, {'horizon': True}, {'wave_count': 7}, {'max_wave_width': 1},
    {'installation_bytes': (-1,)}, {'installation_bytes': (False,)},
    {'installation_bytes': ()}, {'candidates': ()},
])
def test_invalid_plans_reject(changes):
    with pytest.raises(ValueError):
        plan(**changes)


def test_registry_and_price_mismatch_reject():
    p = plan()
    candidate = p.candidates[0]
    for changed in (Layout(tuple(reversed(candidate.registry)), candidate.order, candidate.tree),
                    Layout(candidate.registry, candidate.order, candidate.tree, CostModel(513, 320, 3073))):
        with pytest.raises(ValueError, match='contracts'):
            replace(p, candidates=(changed,))


def test_binding_includes_horizon_radius_installation_and_catalogue():
    p = plan()
    for changed in (replace(p, horizon=2000), replace(p, shift_radius='0.01'),
                    replace(p, installation_bytes=(100,)), replace(p, delta='0.01')):
        assert changed.uid != p.uid
        with pytest.raises(ValueError, match='binding mismatch'):
            assess_adoption(changed, (GOOD,), frozen_plan_digest=p.uid)


@pytest.mark.parametrize('missing', ['freeze', 'sampling', 'shift'])
def test_missing_external_assumptions_remain_unknown(missing):
    p = plan(shift_radius=None) if missing == 'shift' else plan()
    result = assess_adoption(p, (GOOD,) * 1000,
                            frozen_plan_digest=None if missing == 'freeze' else p.uid,
                            sampling_justification=None if missing == 'sampling' else 'synthetic draws')
    assert result['status'] == 'UNKNOWN'
    assert result['selected'] == p.incumbent.uid


def test_sampling_penalty_installation_and_shift_can_each_prevent_adoption():
    assert advice(plan(), (GOOD,))['status'] == 'RETAIN'
    assert advice(plan(), (GOOD,) * 1000)['status'] == 'CONDITIONAL_BENEFIT'
    assert advice(plan(shift_radius='0.1'), (GOOD,) * 1000)['status'] == 'RETAIN'
    assert advice(plan(installation_bytes=(256000,)), (GOOD,) * 1000)['status'] == 'RETAIN'
    assert advice(plan(), (BAD,) * 1000)['status'] == 'RETAIN'


def test_zero_range_and_zero_gain_retain_incumbent():
    p = plan()
    p = replace(p, candidates=(p.incumbent,))
    result = advice(p, (GOOD,))
    assert result['status'] == 'RETAIN'
    assert result['candidates'][0]['envelope']['width'] == 0


def test_one_sided_arithmetic_against_independent_decimal_expression():
    p = plan(installation_bytes=(1234,), shift_radius='0.005')
    result = advice(p, (GOOD,) * 1000)['candidates'][0]
    with localcontext() as context:
        context.prec = 65
        exact = Decimal(256) - Decimal(3584) * (Decimal(20).ln() / Decimal(2000)).sqrt() - Decimal('0.005') * Decimal(3584) - Decimal('1.234')
    actual = Decimal(result['lower_net_expected_bytes_per_epoch'])
    assert actual < exact
    assert abs(actual - exact) < Decimal('1e-50')


def test_catalogue_union_bound_counts_candidates():
    p = plan()
    extra = Layout(p.incumbent.registry, tuple(reversed(p.incumbent.order)), p.candidates[0].tree)
    two = replace(p, candidates=(p.candidates[0], extra), installation_bytes=(0, 0))
    a = advice(p, (GOOD,) * 100)['candidates'][0]
    b = advice(two, (GOOD,) * 100)['candidates'][0]
    assert Decimal(b['sampling_penalty_bytes']) > Decimal(a['sampling_penalty_bytes'])


def test_repeated_episodes_do_not_automatically_supply_sampling_evidence():
    result = assess_adoption(plan(), (GOOD,) * 1000)
    assert result['status'] == 'UNKNOWN'
    assert 'no acceptance or deployment authority' in result['scope']


def test_one_pass_streaming_matches_buffered_advice():
    p = plan()
    data = (GOOD, BAD, GOOD)
    expected = paired_savings(p, data)[0]
    summary = summarize_calibration(p, (x for x in data))
    assert summary['totals'] == [sum(expected)]
    assert summary['episodes'] == len(data)
    assert advice(p, (x for x in data)) == advice(p, data)


def test_streaming_failure_propagates_without_partial_advice():
    def interrupted():
        yield GOOD
        raise OSError('calibration source interrupted')
    with pytest.raises(OSError, match='interrupted'):
        advice(plan(), interrupted())
    with pytest.raises(ValueError, match='nonempty'):
        advice(plan(), iter(()))
