"""Preflight equivalence and corruption gates for observer-only ablation."""
from dataclasses import replace
import json

import pytest

from experiments_v8 import service_core as core, service_baselines as old
from experiments_v11 import service_study as original
from experiments_v12 import observer_ablation as study
from ichact.practical import balanced_layout


@pytest.fixture
def trajectory():
    return core.Trajectory.load('toolz', 'toolz_confirm_009')


@pytest.mark.parametrize('arm', study.ARMS)
def test_all_arms_preserve_oracle_codec_rewind_and_foreign_rejection(trajectory, arm):
    service = study.make_service(trajectory, balanced_layout(trajectory.registry), arm)
    for epoch in (6, 0, 1):
        snap = original.snapshot(trajectory, epoch)
        for query in old.frozen_queries():
            answer = service.query(query['query_id'], snap, query['s'], query['mode'], wave=query.get('wave'))
            study.answer_signature(answer, snap, query)
        subset = list(trajectory.registry[::3])
        assert service._counts(subset) == core.answer_status(snap, subset)['counts']
    before = service._epoch
    foreign = replace(trajectory, report={**trajectory.report, 'snapshot': 'foreign-test'})
    with pytest.raises(ValueError, match='foreign'):
        service._sync(original.snapshot(foreign, 1))
    assert service._epoch == before
    corrupt = replace(original.snapshot(trajectory, 1), executed=tuple(trajectory.registry[-8:]))
    with pytest.raises(ValueError, match='foreign completion'):
        service._sync(corrupt)
    if arm.endswith('observer_disabled'):
        assert all(service.costs.as_dict()[key] == 0 for key in study.BYTE_COUNTERS)
    else:
        assert service.costs.index_maintenance_bytes > 0


@pytest.mark.parametrize('base', ['indexed', 'counter', 'hact_original', 'hact_selected'])
def test_only_observational_counters_change_and_copies_are_independent(trajectory, base):
    layout = balanced_layout(trajectory.registry)
    left = study.make_service(trajectory, layout, base + ':instrumented')
    right = study.make_service(trajectory, layout, base + ':observer_disabled')
    snap = original.snapshot(trajectory, 1)
    for service in (left, right):
        service._sync(snap)
        for query in old.frozen_queries():
            service.query(query['query_id'], snap, query['s'], query['mode'], wave=query.get('wave'))
    for key in ('aggregation_cpu_calls', 'cache_hits', 'cache_misses', 'encode_bytes',
                'decode_bytes', 'pages', 'round_trips', 'failure_disclosures'):
        assert left.costs.as_dict()[key] == right.costs.as_dict()[key]
    if base.startswith('hact'):
        assert left._root == right._root
        assert left._packet_count == right._packet_count
        assert left._capsules == right._capsules
        assert left._records == right._records
    else:
        assert left._ledger == right._ledger
        assert left._index == right._index
    cid = snap.executed[0]
    assert right.record_of(cid) is not snap.records[cid]


def test_oracle_wire_and_kernel_corruption_detected(trajectory):
    snap = original.snapshot(trajectory, 1)
    service = study.make_service(trajectory, balanced_layout(trajectory.registry), 'hact_selected:observer_disabled')
    query = old.frozen_queries()[0]
    answer = service.query(query['query_id'], snap, query['s'], query['mode'])
    answer.extras['compressed']['raw_bytes'] += 1
    with pytest.raises(ValueError, match='wire codec'):
        study.answer_signature(answer, snap, query)
    answer.extras['compressed']['raw_bytes'] -= 1
    answer.extras['kernel_counts'][0] += 1
    with pytest.raises(ValueError, match='kernel/oracle'):
        study.answer_signature(answer, snap, query)


def test_summary_preserves_losses_and_unknown():
    blocks = []
    for repeat in range(3):
        blocks.append({'arm_order': list(study.ARMS), 'executions': [
            {'arm': arm, 'status': 'PASS', 'service_operation_seconds':
             0.5 if arm.startswith('hact_selected') else 1.0} for arm in study.ARMS]})
    raw = {'cases': [{'case': 'fixture', 'project': 'fixture', 'status': 'PASS', 'repetitions': blocks},
                     {'case': 'excluded', 'status': 'UNKNOWN', 'reason': 'declared admission'}]}
    result = study.summarize(raw)
    assert result['all_selected_hact_slower'] == {'instrumented': False, 'observer_disabled': False}
    assert result['excluded'][0]['status'] == 'UNKNOWN'
    raw['cases'][0]['repetitions'][0]['executions'].pop()
    with pytest.raises(ValueError, match='incomplete paired'):
        study.summarize(raw)


def test_duplicate_environment_records_remain_list():
    inventory = study.runtime_inventory()
    assert isinstance(inventory['distributions'], list)
    assert len(inventory['distributions']) >= len({r['name'] for r in inventory['distributions']})
    assert all(r['metadata_sha256'] for r in inventory['distributions'])
