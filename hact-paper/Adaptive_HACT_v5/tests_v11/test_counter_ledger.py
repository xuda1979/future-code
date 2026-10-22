"""Contract tests for the stronger, independently checked ledger control."""
import pytest

from experiments_v8 import service_core as core
from experiments_v8 import service_baselines as old
from experiments_v11.counter_ledger import CounterLedger


@pytest.mark.parametrize('project,case', [
    ('networkx', 'networkx_confirm_000'),
    ('toolz', 'toolz_confirm_009'),
    ('toolz', 'toolz_confirm_011'),
])
@pytest.mark.parametrize('epoch', [0, 1, None])
def test_counter_ledger_answers_match_independent_record_oracle(project, case, epoch):
    trajectory = core.Trajectory.load(project, case)
    service = CounterLedger(trajectory)
    snapshot = trajectory.snapshot(epoch)
    for q in old.frozen_queries():
        answer = service.query(q['query_id'], snapshot, q['s'], q['mode'],
                               wave=q.get('wave'))
        selected = core.select_members(snapshot, q['s'])
        reference = {
            'status': lambda: core.answer_status(snapshot, selected),
            'coverage_proof': lambda: core.answer_coverage_proof(snapshot, selected),
            'failure_localization': lambda: core.answer_failure_localization(snapshot, selected),
            'replay': lambda: core.answer_replay(snapshot, q['wave']),
        }[q['mode']]()
        assert answer.semantic == reference


def test_counts_use_maintained_counters_for_complete_registry():
    t = core.Trajectory.load('networkx', 'networkx_confirm_000')
    service = CounterLedger(t)
    service._sync(t.snapshot())
    before = service.costs.aggregation_cpu_calls
    assert service._counts(list(t.registry)) == {'PASS': 170, 'FAIL': 0, 'UNKNOWN': 0}
    assert service.costs.aggregation_cpu_calls - before == 1
    assert service.counter_updates == len(t.evidence['executed'])


def test_rewind_rebuilds_counters_and_arbitrary_subsets_remain_exact():
    t = core.Trajectory.load('toolz', 'toolz_confirm_009')
    service = CounterLedger(t)
    service._sync(t.snapshot())
    service._sync(t.snapshot(0))
    assert service._counts(list(t.registry)) == {'PASS': 0, 'FAIL': 0, 'UNKNOWN': len(t.registry)}
    service._sync(t.snapshot(1))
    selected = list(t.registry[::3])
    assert service._counts(selected) == core.answer_status(t.snapshot(1), selected)['counts']


def test_foreign_snapshot_rejected_without_counter_changes():
    t = core.Trajectory.load('networkx', 'networkx_confirm_000')
    service = CounterLedger(t)
    before = dict(service._group_counts['all'])
    other = core.Trajectory.load('toolz', 'toolz_confirm_009')
    with pytest.raises(ValueError, match='foreign'):
        service._sync(other.snapshot())
    assert service._group_counts['all'] == before
