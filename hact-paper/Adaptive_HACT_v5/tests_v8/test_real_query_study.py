"""V9 resource ledgers must not equate local storage with transmitted bytes."""
import json
from pathlib import Path

import pytest

from experiments_v8 import real_query_study as study, service_core as core

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope='module')
def measured():
    return study._run_study()


def test_query_workload_includes_missing_obligations_and_is_seeded():
    workload = study.study_workload()
    assert workload == study.study_workload()
    assert set(workload) == set(core.CORPUS)
    assert len(study.failing_cases()) == 9
    for queries in workload.values():
        assert {'Q1', 'Q3', 'Q4', 'Q5', 'Q6a', 'Q6b'} <= {q.query_id for q in queries}


def test_both_layouts_and_real_cold_warm_queries_are_measured(measured):
    rows, _ = measured
    assert {r.layout for r in rows} == {'original', 'learned'}
    assert {r.cache_phase for r in rows} == {'cold', 'warm'}
    assert all(r.equal_semantics for r in rows)
    for row in rows:
        for costs in (row.hact, row.flat):
            assert costs.cache_hits == (row.cache_phase == 'warm')
            assert costs.cache_misses == (row.cache_phase == 'cold')
            assert costs.pages == costs.round_trips > 0


def test_wire_bytes_exclude_local_state(measured):
    rows, setups = measured
    assert all(s['hact']['storage_bytes'] > 0 and s['flat']['storage_bytes'] > 0 for s in setups)
    for row in rows:
        assert 'storage_bytes' not in row.hact.as_dict()
        assert row.hact.compressed_answer_bytes == row.flat.compressed_answer_bytes
    for family in study.decision_table(rows):
        members = [r for r in rows if r.query_id == family['query_family']]
        assert family['hact_wire_bytes'] == sum(r.hact.compressed_answer_bytes for r in members)
        assert family['flat_wire_bytes'] == sum(r.flat.compressed_answer_bytes for r in members)
        assert not family['bytes_better']
        assert not family['hact_beneficial']


def test_setup_is_counted_once_and_allocated_independently_of_query_order(measured):
    rows, setups = measured
    for setup in setups:
        selected = [r for r in rows if r.setup_id == setup['id']]
        assert len(selected) == setup['query_count']
        for arm in ('hact', 'flat'):
            arrivals = [getattr(r, arm + '_arrival') for r in selected]
            setup_seconds = setup[arm]['index_build_seconds'] + setup[arm]['index_maintenance_seconds']
            assert sum(a['allocated_setup_seconds'] for a in arrivals) == pytest.approx(setup_seconds)
            assert len({a['allocated_setup_seconds'] for a in arrivals}) == 1
    assert study.decision_table(rows)[0]['hact_wire_bytes'] == study.decision_table(list(reversed(rows)))[0]['hact_wire_bytes']


def test_modeled_arrival_uses_compressed_wire_and_all_measured_phases(measured):
    rows, _ = measured
    for row in rows:
        for arm in ('hact', 'flat'):
            costs = getattr(row, arm)
            arrival = getattr(row, arm + '_arrival')
            assert arrival['simulated'] is True
            assert arrival['transfer_seconds_at_declared_rate'] == costs.compressed_answer_bytes / study.LINK_BYTES_PER_SECOND
            assert arrival['query_processing_seconds'] == pytest.approx(
                costs.aggregation_seconds + costs.encode_seconds + costs.decode_seconds)
            assert arrival['total_seconds'] == pytest.approx(
                arrival['archived_completion_seconds'] + arrival['allocated_setup_seconds']
                + arrival['query_processing_seconds'] + arrival['transfer_seconds_at_declared_rate'])


def test_amdahl_separates_observed_ratio_from_unbounded_ceiling(measured):
    rows, _ = measured
    result = study.amdahl_from_rows(rows)
    f = result['f_measured']
    assert result['unbounded_aggregation_speedup_ceiling'] == pytest.approx(1 / (1 - f))
    assert result['maximum_latency_reduction_percent'] == pytest.approx(100 * f)


def test_frozen_artifact_reproduces_deterministic_query_fields(measured):
    rows, setups = measured
    stored = json.loads((ROOT / 'results/v9/real_query_cost_study.json').read_text())
    assert stored['schema'] == 'v9-real-query-cost-study-1'
    assert len(stored['setups']) == len(setups)
    assert len(stored['rows']) == len(rows)
    for original, fresh in zip(stored['rows'], rows):
        assert original['setup_id'] == fresh.setup_id
        assert original['cache_phase'] == fresh.cache_phase
        for arm in ('hact', 'flat'):
            actual = getattr(fresh, arm).as_dict()
            for field, expected in original[arm].items():
                if not field.endswith('_seconds'):
                    assert actual[field] == expected, (fresh.setup_id, field)
