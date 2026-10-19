"""The audit must reject the exact sign/unit/prose errors found in review."""
import json

import pytest

from audit import check_v9


@pytest.mark.parametrize('relative,old,new', [
    ('paper/generated_v9/macros.tex', '{5.93}', '{0.06}'),
    ('paper/generated_v9/ablation.tex', 'cost penalties', 'cost improvements'),
    ('paper/generated_v9/query_rows.tex', 'Q1 & 48', 'Q1 & 49'),
])
def test_generated_manuscript_tampering_is_detected(relative, old, new):
    path = check_v9.ROOT / relative
    original = path.read_text()
    assert old in original
    try:
        path.write_text(original.replace(old, new, 1))
        report = check_v9.verify()
        assert report['status'] == 'FAIL'
        assert any(e['claim'] == relative and e['status'] == 'MISMATCH'
                   for e in report['entries'])
    finally:
        path.write_text(original)


def test_independent_audit_passes_current_records_and_generated_prose():
    report = check_v9.verify()
    assert report['status'] == 'PASS'
    assert report['checks'] > 0


def test_corrupt_wire_measurement_cannot_generate_a_new_paper():
    path = check_v9.ROOT / 'results/v9/real_query_cost_study.json'
    original = path.read_text()
    altered = json.loads(original)
    altered['rows'][0]['hact']['compressed_answer_bytes'] += 10
    try:
        path.write_text(json.dumps(altered))
        assert check_v9.verify()['status'] == 'FAIL'
        with pytest.raises(ValueError, match='inconsistent records'):
            check_v9.verify(write=True)
    finally:
        path.write_text(original)


def test_percentage_units_and_direction_are_recomputed_from_raw_rows():
    _, outputs = check_v9.reconstruct()
    correction = json.loads(outputs['results/v9/numerical_corrections.json'])
    assert correction['original_order_exact_penalty_all_percent'] == pytest.approx(5.123195046)
    assert correction['original_order_exact_penalty_cluster_percent'] == pytest.approx(15.172137571)
    assert correction['frequency_penalty_cluster_percent'] == pytest.approx(7.556402192)
    assert correction['maximum_small_fixed_topology_gap_percent'] == pytest.approx(5.925925926)
    assert correction['historical_unbounded_aggregation_speedup_percent'] == pytest.approx(0.178538102)
