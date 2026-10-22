"""Nonvacuous tamper checks for the independently reconstructed v11 claims."""
from copy import deepcopy
from pathlib import Path

import pytest

import audit.check_v11_compiler as audit


def four_leaf_layout():
    leaf = lambda i: {'lo':i, 'hi':i, 'children':[]}
    pair = lambda i: {'lo':i, 'hi':i+1, 'children':[leaf(i),leaf(i+1)]}
    return {'schema':'adaptive-hact-layout-1', 'registry':['a','b','c','d'],
            'order':[0,1,2,3], 'model':{'header':512,'card':320,'cap':3072},
            'tree':{'lo':0,'hi':3,'children':[pair(0),pair(2)]}}


def test_literal_cost_charges_initial_build_and_each_touched_ancestor():
    layout = four_leaf_layout()
    assert audit.score(layout, []) == 3456
    assert audit.score(layout, ['a','d']) == 6912
    assert audit.score(layout, ['a','d'], width=1) == 8064
    assert audit.score_episode(layout, [[0,3]]) == 6912
    assert audit.score_episode(layout, [[0],[3]]) == 8064


@pytest.mark.parametrize('mutation', ['gap','overlap','cap','permutation'])
def test_literal_layout_validation_rejects_invalid_contract(mutation):
    layout = four_leaf_layout()
    if mutation == 'gap':
        layout['tree']['children'][1]['lo'] = 3
    elif mutation == 'overlap':
        layout['tree']['children'][1]['lo'] = 1
    elif mutation == 'cap':
        layout['model']['cap'] = 1000
    else:
        layout['order'] = [0,1,1,3]
    with pytest.raises(AssertionError):
        audit.score(layout, ['a'])


def test_full_registry_and_duplicate_completion_cannot_be_hidden():
    with pytest.raises(AssertionError):
        audit.score(four_leaf_layout(), ['a','a'])
    with pytest.raises(AssertionError):
        audit.score(four_leaf_layout(), ['foreign'])


def test_refinement_scope_rejects_larger_ancestor_change():
    original = four_leaf_layout()
    refined = deepcopy(original)
    refined['tree']['children'] = [{'lo':i,'hi':i,'children':[]} for i in range(4)]
    audit.check_refinement_scope(original, refined, 4)
    with pytest.raises(AssertionError, match='large ancestor arity'):
        audit.check_refinement_scope(original, refined, 2)


def test_tampered_heldout_total_rejected_by_raw_record_reconstruction(monkeypatch):
    original_loader = audit.read_json

    def tampered(path):
        value = original_loader(path)
        path = str(path)
        if path.endswith('public_compiler/click/evaluation.json'):
            value['heldout_total_bytes']['fullwave32'] += 1
        elif path.endswith('public_compiler/SUMMARY.json'):
            next(r for r in value['projects'] if r['project']=='click')['heldout_total_bytes']['fullwave32'] += 1
        return value

    monkeypatch.setattr(audit, 'read_json', tampered)
    with pytest.raises(AssertionError, match='selected total differs'):
        audit.audit_public()


def test_tampered_normalized_status_cannot_masquerade_as_raw_evidence(monkeypatch):
    original_loader = audit.read_json

    def tampered(path):
        value = original_loader(path)
        if str(path).endswith('public_checks_normalized/click/run_0/pytest_evidence.json'):
            passed = next(r for r in value['records'].values() if r['status']=='PASS')
            passed['status'] = 'FAIL'
        return value

    monkeypatch.setattr(audit, 'read_json', tampered)
    with pytest.raises(AssertionError, match='normalization changed actual'):
        audit.normalized_run(audit.ROOT, 'click', 0)


def test_auditor_imports_no_hact_compiler_or_producer_scoring():
    import ast
    tree = ast.parse(Path(audit.__file__).read_text())
    imports = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.extend(x.name for x in node.names)
        elif isinstance(node, ast.ImportFrom):
            imports.append(node.module or '')
    assert not any(name.startswith(('ichact','hact','experiments_v')) for name in imports)


def test_tampered_service_answer_digest_rejected_without_service_helpers(monkeypatch):
    original_loader = audit.read_json

    def tampered(path):
        value = original_loader(path)
        if str(path).endswith('results/v11/service_study.json'):
            value['cases'][0]['repetitions'][0]['executions'][0]['queries'][0]['semantic_sha256'] = '0'*64
        return value

    monkeypatch.setattr(audit, 'read_json', tampered)
    with pytest.raises(AssertionError, match='independent raw-record service answer differs'):
        audit.audit_service()


def test_tampered_source_transfer_total_rejected_by_raw_packets(monkeypatch):
    original_loader = audit.read_json

    def tampered(path):
        value = original_loader(path)
        if str(path).endswith('results/v11/regression_costs.json'):
            next(r for r in value['rows'] if r['case_id']=='click_source_0')['costs']['primary32']['total_bytes'] += 1
        return value

    monkeypatch.setattr(audit, 'read_json', tampered)
    with pytest.raises(AssertionError, match='source transfer byte ledger differs'):
        audit.audit_regressions()
