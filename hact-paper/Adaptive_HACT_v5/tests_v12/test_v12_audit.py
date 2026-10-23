"""Independent raw-record audit and deliberate follow-up data corruptions."""
from copy import deepcopy
import json

import pytest

from audit.check_v12 import (
    ARMS, LAYOUTS, OUTPUT, QUERIES, ROOT, build_report, independent_wire_signature,
    literal_packet_cost, read, validate_schedule_run, validate_service_case,
    validate_service_execution, validate_manuscript_numbers,
)


@pytest.fixture(scope='module')
def schedule_case():
    directory = ROOT / 'results/v12/schedule_shift'
    frozen = read(directory / 'FROZEN_MANIFEST.json')
    entry = next(x for x in frozen['projects'] if x['project'] == 'click')
    path = directory / 'click/files/2026102101'
    layouts = {role: read(ROOT / 'results/v11/public_compiler/click' / name) for role, name in LAYOUTS.items()}
    from pathlib import Path
    return read(path / 'pytest_evidence.json'), read(path / 'receipt.json'), entry, layouts, Path(frozen['source_root']) / 'click'


@pytest.fixture(scope='module')
def service_data():
    directory = ROOT / 'results/v12/service_ablation'
    frozen, raw = read(directory / 'FROZEN_INPUTS.json'), read(directory / 'raw.json')
    case = next(x for x in raw['cases'] if x['status'] == 'PASS')
    evidence, report = (read(ROOT / case[key]) for key in ('evidence', 'report'))
    waves = (len(evidence['executed']) + 7) // 8
    expected = {(epoch, query): independent_wire_signature(evidence, report, epoch, query)
                for epoch in sorted({0, max(1, waves // 2), waves}) for query in QUERIES}
    schedule = {(row['case'], row['repetition']): row['arm_order'] for row in frozen['schedule']}
    declaration = next(x for x in read(ROOT / frozen['case_manifest']) if x['case'] == case['case'])
    return case, declaration, schedule, evidence, report, expected, waves


def test_literal_scorer_pays_cold_tree_and_each_touched_wave():
    layout = {'registry': ['a', 'b'], 'order': [0, 1],
              'model': {'header': 2, 'card': 3, 'cap': 8},
              'tree': {'lo': 0, 'hi': 1, 'children': [
                  {'lo': 0, 'hi': 0, 'children': []}, {'lo': 1, 'hi': 1, 'children': []}]}}
    assert literal_packet_cost(layout, [], width=1) == 8
    assert literal_packet_cost(layout, ['a', 'b'], width=1) == 24
    assert literal_packet_cost(layout, ['a', 'b'], width=8) == 16
    layout['tree']['children'][1]['lo'] = 0
    with pytest.raises(AssertionError, match='interval'):
        literal_packet_cost(layout, ['a', 'b'])


@pytest.mark.parametrize('corruption', ['cost', 'gain', 'actual_schedule', 'policy', 'phase_status', 'source'])
def test_schedule_corruption_rejected(schedule_case, corruption):
    evidence, receipt, entry, layouts, source = deepcopy(schedule_case)
    if corruption == 'cost':
        receipt['costs']['cap32'] += 512
        receipt['gains_vs_original']['cap32'] = 100 * (receipt['costs']['original'] - receipt['costs']['cap32']) / receipt['costs']['original']
    elif corruption == 'gain':
        receipt['gains_vs_original']['cap32'] += 1
    elif corruption == 'actual_schedule':
        evidence['executed'][0], evidence['executed'][1] = evidence['executed'][1], evidence['executed'][0]
    elif corruption == 'policy':
        evidence['schedule_intervention']['policy'] = 'items'
    elif corruption == 'phase_status':
        evidence['records'][evidence['executed'][0]]['status'] = 'FAIL'
    else:
        evidence['production_calls_observed'][0]['sha256'] = '0' * 64
    with pytest.raises(AssertionError):
        validate_schedule_run(evidence, receipt, entry, layouts, source)


@pytest.mark.parametrize('corruption', ['operation_time', 'query_time', 'missing_ingest', 'wire_hash', 'semantic_hash', 'pages', 'null_counter'])
def test_service_operation_and_oracle_corruption_rejected(service_data, corruption):
    case, _, _, _, _, expected, waves = service_data
    execution = deepcopy(next(x for x in case['repetitions'][0]['executions'] if x['arm'].endswith(':observer_disabled')))
    if corruption == 'operation_time':
        execution['operations'][1]['seconds'] += 0.5
    elif corruption == 'query_time':
        execution['queries'][0]['seconds'] += 0.5
    elif corruption == 'missing_ingest':
        execution['operations'].pop(1)
    elif corruption == 'wire_hash':
        execution['queries'][0]['oracle_wire_sha256'] = '0' * 64
    elif corruption == 'semantic_hash':
        execution['queries'][0]['semantic_sha256'] = '0' * 64
    elif corruption == 'pages':
        execution['queries'][0]['pages'] += 1
    else:
        execution['costs']['storage_bytes'] = 0
    with pytest.raises(AssertionError):
        validate_service_execution(execution, expected, waves)


def test_arm_identity_cannot_be_duplicated_or_omitted(service_data):
    case, declaration, schedule, evidence, report, _, _ = service_data
    altered = deepcopy(case)
    altered['repetitions'][0]['executions'][0]['arm'] = altered['repetitions'][0]['executions'][1]['arm']
    with pytest.raises(AssertionError, match='arm order'):
        validate_service_case(altered, declaration, schedule, evidence, report)


def test_resource_exclusion_cannot_be_promoted_or_imputed():
    directory = ROOT / 'results/v12/service_ablation'
    raw, frozen = read(directory / 'raw.json'), read(directory / 'FROZEN_INPUTS.json')
    case = next(x for x in raw['cases'] if x['project'] == 'packaging')
    declaration = next(x for x in read(ROOT / frozen['case_manifest']) if x['case'] == case['case'])
    evidence, report = (read(ROOT / case[key]) for key in ('evidence', 'report'))
    altered = deepcopy(case)
    altered['status'] = 'PASS'
    with pytest.raises(AssertionError, match='exclusion'):
        validate_service_case(altered, declaration, {}, evidence, report)


def test_initial_generated_source_failure_remains_void():
    directory = ROOT / 'results/v12/schedule_shift'
    frozen = read(directory / 'FROZEN_MANIFEST.json')
    entry = next(x for x in frozen['projects'] if x['project'] == 'exceptiongroup')
    path = directory / 'exceptiongroup/files/2026102101'
    evidence, receipt = read(path / 'pytest_evidence.json'), read(path / 'receipt.json')
    layouts = {role: read(ROOT / 'results/v11/public_compiler/exceptiongroup' / name) for role, name in LAYOUTS.items()}
    from pathlib import Path
    source = Path(frozen['source_root']) / 'exceptiongroup'
    assert validate_schedule_run(evidence, receipt, entry, layouts, source)['status'] == 'VOID'
    receipt['status'] = 'PASS'
    with pytest.raises(AssertionError, match='exclusion or promotion'):
        validate_schedule_run(evidence, receipt, entry, layouts, source)


def test_full_independent_audit_matches_persisted_report():
    report = build_report()
    assert report == json.loads(OUTPUT.read_text())
    assert report['schedule']['status_counts'] == {'PASS': 24, 'VOID': 6}
    assert report['schedule_generated_metadata']['status_counts'] == {'PASS': 6}
    assert report['combined_schedule']['attempted_processes'] == 36
    assert report['combined_schedule']['admitted_runs'] == 30
    assert report['service_ablation']['raw_query_rows_checked'] == 10080
    assert report['service_ablation']['admitted_cases'] == 10
    assert report['service_ablation']['resource_unknown_cases'] == 2


@pytest.mark.parametrize('corruption', ['count', 'ratio'])
def test_manuscript_numeric_projection_corruption_rejected(corruption):
    audit = read(OUTPUT)
    data = read(ROOT / 'results/v12/manuscript_numbers.json')
    if corruption == 'count':
        data['actual_scheduling_check_executions'] -= 612
    else:
        data['service'][0]['states']['observer_disabled']['ratio'] = 0.5
    with pytest.raises(AssertionError):
        validate_manuscript_numbers(data, audit['schedule'], audit['schedule_generated_metadata'], audit['service_ablation'])
