"""Exploratory transport of frozen release layouts to historical-source cases.

This evaluator uses only persisted JSON and integer arithmetic. It neither
refits nor selects a layout on source-transplant outcomes. Successful runs
are not assumed to be native historical bugs or independent projects.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'results/v11/regression_costs.json'


def read(path):
    return json.loads((ROOT / path).read_text())


def file_hash(path):
    return hashlib.sha256((ROOT / path).read_bytes()).hexdigest()


def price_raw(layout, executed):
    """Reconstruct actual touched internal packets, independently of HACT."""
    registry, order = layout['registry'], layout['order']
    n = len(registry)
    if not n or len(set(registry)) != n or any(type(i) is not int for i in order):
        raise ValueError('invalid semantic registry or order')
    if len(order) != n or set(order) != set(range(n)):
        raise ValueError('order is not a permutation')
    if len(set(executed)) != len(executed) or not set(executed) <= set(registry):
        raise ValueError('foreign or repeated completion')
    model = layout['model']
    prices, ancestors, seen = [], {cid: [] for cid in registry}, set()

    def walk(node, chain):
        lo, hi, children = node['lo'], node['hi'], node['children']
        if any(type(x) is not int for x in (lo, hi)) or not 0 <= lo <= hi < n:
            raise ValueError('invalid interval')
        if not children:
            if lo != hi or lo in seen:
                raise ValueError('invalid leaf')
            seen.add(lo)
            ancestors[registry[order[lo]]] = chain
            return
        if not 2 <= len(children) <= (model['cap'] - model['header']) // model['card']:
            raise ValueError('invalid packet arity')
        price_id = len(prices)
        prices.append(model['header'] + model['card'] * len(children))
        boundary = lo
        for child in children:
            if child['lo'] != boundary:
                raise ValueError('nonpartitioning child intervals')
            walk(child, chain + [price_id])
            boundary = child['hi'] + 1
        if boundary != hi + 1:
            raise ValueError('missing child coverage')
    if (layout['tree']['lo'], layout['tree']['hi']) != (0, n - 1):
        raise ValueError('incomplete root')
    walk(layout['tree'], [])
    if seen != set(range(n)):
        raise ValueError('missing semantic obligations')
    wave_bytes = []
    for offset in range(0, len(executed), 8):
        touched = set()
        for cid in executed[offset:offset + 8]:
            touched.update(ancestors[cid])
        wave_bytes.append(sum(prices[i] for i in touched))
    cold = sum(prices)
    return {'construction_bytes': cold, 'refresh_bytes': sum(wave_bytes),
            'total_bytes': cold + sum(wave_bytes), 'waves': len(wave_bytes)}


def build_report():
    summary_path = 'results/v11/public_regressions/COLLECTION_SUMMARY.json'
    summary = read(summary_path)
    rows = []
    for case in summary['cases']:
        row = {k: case.get(k) for k in ('case_id', 'project', 'n', 'completed', 'counts')}
        if not case['eligible_for_paired_costs']:
            row.update(status='VOID', reason=case.get('paired_cost_exclusion') or
                       case.get('exclusion') or 'changed declared semantic registry')
            rows.append(row)
            continue
        project = case['project']
        evidence_path = 'results/v11/public_regressions/%s/%s/pytest_evidence.json' % (project, case['case_id'])
        evidence = read(evidence_path)
        base = 'results/v11/public_compiler/%s/' % project
        receipt = read(base + 'fit_receipt.json')
        if receipt['status'] != 'PASS':
            path = base + 'service_fallback_layout.json'
            fallback = read(path)
            row.update(status='UNKNOWN', reason='release compiler resource admission',
                fallback_cost=price_raw(fallback, evidence['executed']),
                evidence_sha256=file_hash(evidence_path), layout_sha256=file_hash(path))
            rows.append(row)
            continue
        layouts = {'historical': 'historical_layout.json',
                   'primary32': 'selected_layout.json',
                   'secondary64': 'selected_layout_sensitivity.json'}
        costs, hashes = {}, {}
        for arm, name in layouts.items():
            path = base + name
            layout = read(path)
            if set(layout['registry']) != set(evidence['registry']):
                raise ValueError('source case changed declared semantic registry')
            costs[arm] = price_raw(layout, evidence['executed'])
            hashes[arm] = file_hash(path)
        original = costs['historical']['total_bytes']
        row.update(status='PASS', costs=costs,
            primary_saving_fraction=1 - costs['primary32']['total_bytes'] / original,
            secondary_saving_fraction=1 - costs['secondary64']['total_bytes'] / original,
            evidence_sha256=file_hash(evidence_path), layout_sha256=hashes,
            source_fix_commit=case['source_case']['commit'],
            source_parent_commit=case['source_case']['parent'])
        rows.append(row)
    valid = [r for r in rows if r['status'] == 'PASS']
    return {'schema': 'hact-v11-source-transfer-costs-1',
        'scope': 'exploratory historical-source transplants under release tests; no new layout fitting',
        'inference_unit': 'project/source case; cases share release suites and are not independent projects',
        'selection_summary_sha256': file_hash(summary_path),
        'fit_freeze_sha256': file_hash('results/v11/public_compiler/FIT_FROZEN.json'),
        'attempted': len(rows), 'compared': len(valid),
        'primary': {key: sum((r['primary_saving_fraction'] > 0 if key == 'wins' else
                             r['primary_saving_fraction'] == 0 if key == 'ties' else
                             r['primary_saving_fraction'] < 0) for r in valid)
                    for key in ('wins', 'ties', 'losses')},
        'rows': rows}


if __name__ == '__main__':
    report = build_report()
    OUTPUT.write_text(json.dumps(report, indent=2, sort_keys=True) + '\n')
    print(json.dumps({k: report[k] for k in ('attempted', 'compared', 'primary')}))
