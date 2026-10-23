"""Independent audit of v12 controlled follow-ups; never runs a benchmark.

The tree evaluator and page/wire reconstruction below use persisted JSON only.
No producer, optimizer, HACT model, service implementation, or producer scorer
is imported. Raw query semantics reuse the separately implemented v11 auditor.
Passing means consistency with retained records, not population significance.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime
import hashlib
import json
import math
from pathlib import Path
import random
from statistics import mean, median
import zlib

from audit.check_v11_compiler import raw_service_answer

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / '.ai-loop/v12/reports/independent_followups.json'
PROJECTS = ('click', 'jinja', 'pluggy', 'attrs', 'exceptiongroup')
POLICIES = ('files', 'items')
SEEDS = (2026102101, 2026102102, 2026102103)
LAYOUTS = {'original': 'layout_original_compact.json', 'historical': 'historical_layout.json',
           'cap32': 'selected_layout.json', 'cap64': 'selected_layout_sensitivity.json'}
ARMS = tuple(base + ':' + state for base in ('indexed', 'counter', 'hact_original', 'hact_selected')
             for state in ('instrumented', 'observer_disabled'))
QUERIES = ('Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6a', 'Q6b')
BYTE_COUNTERS = ('index_build_bytes', 'index_maintenance_bytes', 'storage_bytes', 'aggregation_bytes_scanned')


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def read(path):
    return json.loads(Path(path).read_text())


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('ascii')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def finite_nonnegative(value):
    return type(value) in (float, int) and math.isfinite(value) and value >= 0


def verify_hashes(root, entries):
    require(bool(entries), 'empty frozen hash inventory')
    for name, expected in entries.items():
        path = root / name
        require(path.is_file() and sha(path) == expected, 'frozen file changed: ' + name)


def literal_packet_cost(layout, executed, width=8):
    """Bottom-up semantic coverage recursion, separate from producer paths."""
    registry, order, model = (layout[key] for key in ('registry', 'order', 'model'))
    n = len(registry)
    require(n and len(set(registry)) == n, 'nonunique or empty layout registry')
    require(all(type(i) is int for i in order) and sorted(order) == list(range(n)), 'invalid layout permutation')
    require(all(type(model[k]) is int and model[k] > 0 for k in ('header', 'card', 'cap')), 'invalid packet model')
    require(type(width) is int and width > 0, 'invalid wave width')
    require(len(executed) == len(set(executed)) and set(executed) <= set(registry), 'invalid executed IDs')
    waves = [set(executed[start:start + width]) for start in range(0, len(executed), width)]
    def visit(node):
        require(set(node) == {'lo', 'hi', 'children'}, 'malformed literal node')
        lo, hi, children = node['lo'], node['hi'], node['children']
        require(type(lo) is int and type(hi) is int and 0 <= lo <= hi < n, 'invalid node interval')
        require(isinstance(children, list), 'invalid child list')
        if not children:
            require(lo == hi, 'nonsingleton leaf')
            return {registry[order[lo]]}, 0
        price = model['header'] + model['card'] * len(children)
        require(len(children) >= 2 and price <= model['cap'], 'arity or packet cap violation')
        expected, members, below = lo, set(), 0
        for child in children:
            require(child['lo'] == expected, 'gapped or overlapping child interval')
            labels, cost = visit(child)
            require(not members & labels, 'duplicate child coverage')
            members |= labels
            below += cost
            expected = child['hi'] + 1
        require(expected == hi + 1, 'incomplete parent interval')
        return members, below + price * (1 + sum(bool(members & wave) for wave in waves))
    members, value = visit(layout['tree'])
    require(members == set(registry), 'incomplete root registry')
    return value


def expected_schedule(ids, policy, seed):
    require(len(ids) == len(set(ids)), 'duplicate collected ID')
    rng = random.Random(seed)
    if policy == 'items':
        result = list(ids)
        rng.shuffle(result)
        return result
    require(policy == 'files', 'undeclared schedule policy')
    paths = list(dict.fromkeys(cid.partition('::')[0] for cid in ids))
    rng.shuffle(paths)
    return [cid for path in paths for cid in ids if cid.partition('::')[0] == path]


def phase_status(record):
    phases = record['phases']
    if any(phase['outcome'] == 'failed' for phase in phases.values()):
        return 'FAIL'
    if set(phases) == {'setup', 'call', 'teardown'} and all(
            phase['outcome'] == 'passed' and not phase.get('wasxfail') for phase in phases.values()):
        return 'PASS'
    return 'UNKNOWN'


def validate_schedule_run(evidence, receipt, entry, layouts, source_root):
    """Reconstruct eligibility, retained outcomes and costs from one raw run."""
    registry, executed, records = (evidence[key] for key in ('registry', 'executed', 'records'))
    require(len(registry) == len(set(registry)) and len(executed) == len(set(executed)), 'duplicate raw registry/completion')
    require(set(executed) <= set(registry) and set(records) == set(executed), 'raw record/completion mismatch')
    require(all(record['status'] == phase_status(record) for record in records.values()), 'recorded status differs from phases')
    require(all(finite_nonnegative(record['wall_seconds']) for record in records.values()), 'invalid observed check time')
    counts = dict(Counter(record['status'] for record in records.values()))
    reason = None
    if set(executed) != set(registry):
        reason = 'suite execution is not complete'
    elif not evidence.get('session_finished') or receipt.get('timeout'):
        reason = 'incomplete or timed-out session'
    elif receipt['returncode'] not in (0, 1) or evidence.get('collection_errors'):
        reason = 'collection/startup/process failure'
    elif sorted(registry) != sorted(layouts['original']['registry']):
        reason = 'acceptance registry changed'
    else:
        intervention = evidence['schedule_intervention']
        expected = expected_schedule(intervention['original_collection'], receipt['policy'], receipt['seed'])
        if (intervention['policy'], intervention['seed']) != (receipt['policy'], receipt['seed']):
            reason = 'wrong dispatch intervention'
        elif evidence['scheduled'] != expected or executed != expected:
            reason = 'actual execution does not match recorded schedule'
        elif not evidence['production_calls_observed']:
            reason = 'missing production execution provenance'
        else:
            origins = evidence['package_origins']
            if set(origins) != set(entry['target_modules']) or not all(x.get('inside_source_root') for x in origins.values()):
                reason = 'wrong package import origin'
            elif any(entry['source_file_sha256'].get(x['path']) != x['sha256'] for x in evidence['production_calls_observed']):
                reason = 'executed production source mismatch'
            for origin in origins.values():
                path = Path(origin['path'])
                require(path.is_relative_to(source_root), 'package origin lies outside declared source tree')
                relative = path.relative_to(source_root).as_posix()
                require(entry['source_file_sha256'].get(relative) == origin['sha256'], 'package origin digest mismatch')
    if reason:
        expected_status = 'UNKNOWN' if receipt.get('timeout') else 'VOID'
        require(receipt['status'] == expected_status and receipt.get('reason') == reason, 'invalid schedule exclusion or promotion')
        require(not any(key in receipt for key in ('costs', 'gains_vs_original', 'cap32_gain_vs_historical')), 'excluded schedule has imputed costs')
        return {'status': expected_status, 'reason': reason, 'counts': counts, 'n': len(registry)}
    require(receipt['status'] == 'PASS' and 'reason' not in receipt, 'valid schedule incorrectly excluded')
    require(receipt['n'] == receipt['completed'] == len(registry) and receipt['complete'] is True, 'receipt completion count differs')
    require(receipt['counts'] == counts, 'receipt outcome counts differ')
    original = layouts['original']
    require(all(x['registry'] == original['registry'] and x['model'] == original['model'] for x in layouts.values()), 'layout contract drift')
    costs = {role: literal_packet_cost(layout, executed) for role, layout in layouts.items()}
    require(receipt['costs'] == costs, 'schedule packet costs differ from literal reconstruction')
    gains = {role: 100 * (costs['original'] - value) / costs['original'] for role, value in costs.items()}
    require(receipt['gains_vs_original'] == gains, 'schedule gains differ')
    gain = 100 * (costs['historical'] - costs['cap32']) / costs['historical']
    require(receipt['cap32_gain_vs_historical'] == gain, 'historical comparison gain differs')
    return {'status': 'PASS', 'n': len(registry), 'counts': counts, 'costs': costs,
            'gains_vs_original': gains, 'cap32_gain_vs_historical': gain}


def audit_schedule(root=ROOT, relative='results/v12/schedule_shift'):
    directory = root / relative
    frozen = read(directory / 'FROZEN_MANIFEST.json')
    summary = read(directory / 'SUMMARY.json')
    require(frozen['policies'] == list(POLICIES) and frozen['seeds'] == list(SEEDS)
            and frozen['wave_width'] == 8 and frozen['layout_roles'] == LAYOUTS, 'frozen schedule protocol differs')
    child = relative == 'results/v12/schedule_generated_metadata'
    expected_projects = ['exceptiongroup'] if child else list(PROJECTS)
    expected_runs = 6 if child else 30
    require([p['project'] for p in frozen['projects']] == expected_projects, 'schedule project set/order changed')
    if child:
        parent_path = root / 'results/v12/schedule_shift/FROZEN_MANIFEST.json'
        parent = read(parent_path)
        require(frozen['parent_manifest_sha256'] == sha(parent_path) and frozen['expected_runs'] == 6,
                'generated-metadata child is not bound to parent')
        require(frozen['environment'] == parent['environment'], 'repair changed installed environment')
        require(all(frozen['files_sha256'].get(name) == digest for name, digest in parent['files_sha256'].items()),
                'repair changed an inherited frozen input')
        original = next(entry for entry in parent['projects'] if entry['project'] == 'exceptiongroup')
        augmented = json.loads(json.dumps(original))
        generated = 'src/exceptiongroup/_version.py'
        generated_hash = sha(directory / 'generated_version.py')
        augmented['generated_runtime_files'] = {generated: generated_hash}
        augmented['source_file_sha256'][generated] = generated_hash
        augmented['tracked_source_manifest_sha256'] = original['source_manifest_sha256']
        augmented['source_manifest_sha256'] = hashlib.sha256(canonical(augmented['source_file_sha256'])).hexdigest()
        require(frozen['projects'] == [augmented], 'repair changed more than the declared generated module')
        require(generated not in original['source_file_sha256'], 'generated module was already admitted by parent')
        require(summary.get('expected_runs') == 6, 'child expected-run count differs')
    require(frozen['excluded_project'] == {'project': 'packaging', 'status': 'UNKNOWN',
            'reason': 'unchanged v11 dense fitting budget'}, 'schedule resource exclusion changed')
    verify_hashes(root, frozen['files_sha256'])
    manifest_hash = sha(directory / 'FROZEN_MANIFEST.json')
    environment_hash = hashlib.sha256(canonical(frozen['environment'])).hexdigest()
    require(isinstance(frozen['environment']['packages_with_locations'], list), 'dependency multiplicity lost')
    require(summary['manifest_sha256'] == manifest_hash and summary['complete'] is True, 'schedule summary not complete/bound')
    rows, receipts, bindings = [], [], {}
    for entry in frozen['projects']:
        source_files = entry['source_file_sha256']
        require(hashlib.sha256(canonical(source_files)).hexdigest() == entry['source_manifest_sha256'], 'source inventory digest differs')
        layouts = {role: read(root / 'results/v11/public_compiler' / entry['project'] / name) for role, name in LAYOUTS.items()}
        for policy in POLICIES:
            for seed in SEEDS:
                case_dir = directory / entry['project'] / policy / str(seed)
                receipt, evidence = read(case_dir / 'receipt.json'), read(case_dir / 'pytest_evidence.json')
                require((receipt['project'], receipt['policy'], receipt['seed']) == (entry['project'], policy, seed), 'schedule run identity differs')
                require(receipt['frozen_manifest_sha256'] == manifest_hash and receipt['environment_sha256'] == environment_hash, 'run manifest/environment binding differs')
                require(datetime.fromisoformat(frozen['frozen_at']) <= datetime.fromisoformat(receipt['started_at']) <= datetime.fromisoformat(receipt['ended_at']), 'schedule chronology differs')
                source_root = Path(frozen['source_root']) / entry['project']
                require(Path(receipt['cwd']) == source_root, 'run source checkout differs')
                require(finite_nonnegative(receipt['wall_seconds']), 'invalid run elapsed time')
                if receipt['status'] == 'PASS':
                    require(receipt['evidence_sha256'] == sha(case_dir / 'pytest_evidence.json'), 'schedule evidence binding differs')
                checked = validate_schedule_run(evidence, receipt, entry, layouts, source_root)
                rows.append({'project': entry['project'], 'policy': policy, 'seed': seed, **checked})
                receipts.append(receipt)
                for name in ('receipt.json', 'pytest_evidence.json'):
                    bindings[str((case_dir / name).relative_to(root))] = sha(case_dir / name)
    require(summary['runs'] == receipts and len(receipts) == expected_runs, 'schedule summary dropped/reordered/changed raw receipts')
    require(summary['status_counts'] == dict(Counter(row['status'] for row in rows)), 'schedule status counts differ')
    policy_results = {}
    for policy in POLICIES:
        valid = [row for row in rows if row['policy'] == policy and row['status'] == 'PASS']
        policy_results[policy] = {role: dict(Counter('win' if row['costs'][role] < row['costs']['original'] else
                'loss' if row['costs'][role] > row['costs']['original'] else 'tie' for row in valid)) for role in LAYOUTS if role != 'original'}
    return {'attempted_runs': expected_runs, 'status_counts': summary['status_counts'], 'rows': rows,
            'wins_ties_losses_vs_original': policy_results, 'resource_exclusion': frozen['excluded_project'],
            'frozen_manifest_sha256': manifest_hash, 'raw_files_sha256': bindings}


def independent_wire_signature(evidence, report, epoch, query):
    """Reconstruct JSON-lines pages and their compressed bytes from raw semantics."""
    semantic = raw_service_answer(evidence, report, epoch, query)
    atoms = []
    for key in sorted(semantic):
        value = semantic[key]
        if isinstance(value, list) and value:
            fragments = [{key: [entry]} for entry in value]
        elif isinstance(value, dict) and value:
            fragments = [{key: {name: value[name]}} for name in sorted(value)]
        else:
            fragments = [{key: value}]
        atoms.extend(canonical(fragment) + b'\n' for fragment in fragments)
    maximum = len(atoms) + 1
    allowance = 16384 - len(canonical({'page': maximum, 'total_pages': maximum})) - 1
    chunks, buffer = [], b''
    for atom in atoms:
        require(len(atom) <= allowance, 'raw oracle atom exceeds frozen page budget')
        if len(buffer) + len(atom) > allowance:
            chunks.append(buffer)
            buffer = b''
        buffer += atom
    if buffer:
        chunks.append(buffer)
    total = len(chunks) + 1
    identity = {key: report[key] for key in ('snapshot', 'checker', 'environment', 'registry_hash')}
    header = {'schema': 'v9-service-answers-1', 'query': query, 'epoch': epoch,
              'total_waves': (len(evidence['executed']) + 7) // 8, 'identity': identity}
    pages = [canonical({'page': 1, 'total_pages': total, 'header': header}) + b'\n']
    pages += [canonical({'page': index, 'total_pages': total}) + b'\n' + chunk for index, chunk in enumerate(chunks, 2)]
    require(all(len(page) <= 16384 for page in pages), 'oracle page cap exceeded')
    raw = b''.join(pages)
    wire = zlib.compress(raw, 6)
    return {'semantic_sha256': hashlib.sha256(canonical(semantic)).hexdigest(),
            'raw_bytes': len(raw), 'wire_bytes': len(wire), 'oracle_wire_sha256': hashlib.sha256(wire).hexdigest(), 'pages': len(pages)}


def validate_service_execution(execution, expected, waves):
    require(execution['arm'] in ARMS and execution['status'] == 'PASS', 'failed or unknown service arm')
    require(execution['input_preparation_and_oracle_seconds_excluded'] is True, 'timing boundary changed')
    rows, operations, costs = (execution[key] for key in ('queries', 'operations', 'costs'))
    epochs = sorted({0, max(1, waves // 2), waves})
    keys = [(epoch, query, phase) for epoch in epochs for query in QUERIES for phase in ('cold', 'warm')]
    require([(row['epoch'], row['query'], row['phase']) for row in rows] == keys, 'service query schedule changed')
    expected_ops = [{'operation': 'build'}]
    for epoch in range(waves + 1):
        expected_ops.append({'operation': 'ingest', 'epoch': epoch})
        if epoch in epochs:
            expected_ops.extend({'operation': 'query', 'epoch': epoch, 'query': query, 'phase': phase}
                                for query in QUERIES for phase in ('cold', 'warm'))
    require([{key: value for key, value in row.items() if key != 'seconds'} for row in operations] == expected_ops, 'build/ingest/query operation schedule changed')
    require(all(finite_nonnegative(row['seconds']) for row in operations + rows), 'invalid operation/query time')
    require(execution['build_seconds'] == operations[0]['seconds'], 'build operation timing differs')
    require(execution['service_operation_seconds'] == sum(row['seconds'] for row in operations), 'operation time sum differs')
    require(execution['query_seconds'] == sum(row['seconds'] for row in rows), 'query time sum differs')
    require([row['seconds'] for row in operations if row['operation'] == 'query'] == [row['seconds'] for row in rows], 'query operation timings differ')
    for row in rows:
        signature = {key: value for key, value in row.items() if key not in ('epoch', 'query', 'phase', 'seconds')}
        require(signature == expected[(row['epoch'], row['query'])], 'raw-record semantic/page/wire signature differs')
    disabled = execution['arm'].endswith(':observer_disabled')
    require(all(costs[key] is None if disabled else finite_nonnegative(costs[key]) for key in BYTE_COUNTERS), 'disabled observer counters must be null')
    require(all(finite_nonnegative(value) for key, value in costs.items() if key not in BYTE_COUNTERS), 'invalid service cost ledger')
    for field, row_field in (('encode_bytes', 'wire_bytes'), ('decode_bytes', 'raw_bytes'), ('pages', 'pages'), ('round_trips', 'pages')):
        require(costs[field] == sum(row[row_field] for row in rows), 'codec/page ledger sum differs')
    require(costs['cache_hits'] == costs['cache_misses'] == len(keys) // 2, 'cold/warm cache ledger differs')
    require(execution['service_operation_seconds'] + 1e-8 >= execution['query_seconds'] + costs['index_build_seconds'] + costs['index_maintenance_seconds'], 'service time omits timed stages')
    return execution['service_operation_seconds']


def validate_service_case(case, declaration, schedule, evidence, report):
    require(all(case.get(key) == value for key, value in declaration.items()), 'service case input identity differs')
    registry, executed = evidence['registry'], evidence['executed']
    require(len(registry) == len(set(registry)) and len(executed) == len(set(executed))
            and set(executed) == set(evidence['records']) <= set(registry), 'invalid service raw registry')
    require(case['n'] == len(registry), 'service registry size differs')
    if len(registry) > 2048:
        require(case['project'] == 'packaging' and case['status'] == 'UNKNOWN' and not case['repetitions']
                and case.get('reason') == 'frozen complete-registry service admission >2048; no imputation', 'resource exclusion was changed or imputed')
        return {'case': case['case'], 'status': 'UNKNOWN', 'reason': case['reason']}, 0
    require(case['status'] == 'PASS' and len(case['repetitions']) == 3, 'admitted service case incomplete')
    waves = (len(executed) + 7) // 8
    expected = {(epoch, query): independent_wire_signature(evidence, report, epoch, query)
                for epoch in sorted({0, max(1, waves // 2), waves}) for query in QUERIES}
    values = {arm: [] for arm in ARMS}
    checked = 0
    for index, block in enumerate(case['repetitions']):
        order = schedule[(case['case'], index)]
        require(block['repetition'] == index and block['arm_order'] == order
                and len(order) == 8 and set(order) == set(ARMS), 'service paired arm schedule differs')
        require([execution['arm'] for execution in block['executions']] == order, 'service actual arm order differs')
        for execution in block['executions']:
            values[execution['arm']].append(validate_service_execution(execution, expected, waves))
            checked += len(execution['queries'])
    medians = {arm: median(times) for arm, times in values.items()}
    states = {}
    for state in ('instrumented', 'observer_disabled'):
        ratios = [hact / counter for hact, counter in zip(values['hact_selected:' + state], values['counter:' + state])]
        states[state] = {'paired_ratios': ratios, 'min': min(ratios), 'max': max(ratios),
                         'median_paired_ratio': median(ratios),
                         'ratio_of_arm_medians': medians['hact_selected:' + state] / medians['counter:' + state]}
    return {'case': case['case'], 'project': case['project'], 'median_operation_seconds': medians,
            'selected_hact_vs_counter': states}, checked


def audit_service(root=ROOT):
    directory = root / 'results/v12/service_ablation'
    frozen, raw, summary = (read(directory / name) for name in ('FROZEN_INPUTS.json', 'raw.json', 'SUMMARY.json'))
    verify_hashes(root, frozen['hashes'])
    require(frozen['seed'] == 20261022 and frozen['repeats'] == 3, 'service protocol seed/repeats changed')
    require(raw['freeze_sha256'] == sha(directory / 'FROZEN_INPUTS.json'), 'service freeze binding differs')
    require(raw['status'] == 'UNKNOWN' and raw['admitted_status'] == 'PASS' and 'failure' not in raw, 'service campaign promoted or incomplete')
    require(datetime.fromisoformat(frozen['frozen_utc']) <= datetime.fromisoformat(raw['started_utc'])
            <= datetime.fromisoformat(raw['finished_utc']), 'service freeze chronology differs')
    require(raw['preflight'] == {'status': 'PASS', 'oracle_wire_checks': 168, 'arms': 8,
            'rewind_and_foreign_snapshot': 'PASS'}, 'service preflight missing or changed')
    declarations = read(root / frozen['case_manifest'])
    require(len(declarations) == len(raw['cases']) == 12 and [case['case'] for case in raw['cases']] == [case['case'] for case in declarations], 'service cohort clipped or reordered')
    rng, regenerated = random.Random(20261022), []
    for case in declarations:
        evidence = read(root / case['evidence'])
        if len(evidence['registry']) <= 2048:
            for repeat in range(3):
                order = list(ARMS)
                rng.shuffle(order)
                regenerated.append({'case': case['case'], 'repetition': repeat, 'arm_order': order})
    require(frozen['schedule'] == regenerated and len(regenerated) == 30, 'frozen paired randomization differs')
    require(isinstance(frozen['runtime']['distributions'], list), 'service environment duplicate records lost')
    names = Counter((d['name'] or '').lower().replace('_', '-') for d in frozen['runtime']['distributions'])
    require(frozen['runtime']['duplicate_distribution_names'] == {name: count for name, count in names.items() if count > 1}, 'environment duplicate count differs')
    schedule = {(row['case'], row['repetition']): row['arm_order'] for row in regenerated}
    measured, excluded, checked = [], [], 0
    for case, declaration in zip(raw['cases'], declarations):
        evidence, report = (read(root / case[key]) for key in ('evidence', 'report'))
        result, count = validate_service_case(case, declaration, schedule, evidence, report)
        checked += count
        if result.get('status') == 'UNKNOWN':
            excluded.append(result)
        else:
            measured.append(result)
    require(len(measured) == 10 and len(excluded) == 2 and checked == 10080, 'service arm/query accounting differs')
    require(summary['cases'] == measured and summary['excluded'] == excluded, 'service summary cases/exclusions differ')
    all_slower = {state: all(ratio > 1 for case in measured for ratio in case['selected_hact_vs_counter'][state]['paired_ratios'])
                  for state in ('instrumented', 'observer_disabled')}
    require(summary['all_selected_hact_slower'] == all_slower, 'service slower/winner statement differs')
    return {'admitted_cases': 10, 'resource_unknown_cases': 2, 'arms_per_repeat': 8, 'repeats': 3,
            'raw_query_rows_checked': checked, 'cases': measured, 'excluded': excluded,
            'all_selected_hact_slower': all_slower,
            'raw_sha256': sha(directory / 'raw.json'), 'summary_sha256': sha(directory / 'SUMMARY.json'),
            'frozen_inputs_sha256': sha(directory / 'FROZEN_INPUTS.json')}


def validate_manuscript_numbers(data, initial, repaired, service, root=ROOT):
    admitted = [row for row in initial['rows'] if row['status'] == 'PASS'] + repaired['rows']
    require(data['actual_scheduling_processes'] == len(initial['rows']) + len(repaired['rows'])
            and data['initial_void'] == sum(row['status'] == 'VOID' for row in initial['rows']),
            'manuscript process/exclusion count differs')
    require(data['actual_scheduling_check_executions'] == sum(row['n'] for row in initial['rows'] + repaired['rows'])
            and data['admitted_scheduling_check_executions'] == sum(row['n'] for row in admitted),
            'manuscript check execution count differs')
    expected_schedule, outcomes = [], {}
    for policy in POLICIES:
        rows = [row for row in admitted if row['policy'] == policy]
        outcomes[policy] = {base: dict(Counter('win' if row['costs']['cap32'] < row['costs'][base] else
                'loss' if row['costs']['cap32'] > row['costs'][base] else 'tie' for row in rows))
                for base in ('original', 'historical')}
        for project in PROJECTS:
            selected = sorted((row for row in rows if row['project'] == project), key=lambda row: row['seed'])
            gains = {base: [100 * (row['costs'][base] - row['costs']['cap32']) / row['costs'][base]
                           for row in selected] for base in ('original', 'historical')}
            secondary = [100 * (row['costs']['historical'] - row['costs']['cap64']) / row['costs']['historical']
                         for row in selected]
            expected_schedule.append({'project': project, 'policy': policy, 'gains': gains,
                                      'cap64_vs_historical': secondary, 'costs': [row['costs'] for row in selected]})
    require(data['schedule'] == expected_schedule and data['schedule_outcomes'] == outcomes,
            'manuscript dispatch numbers differ from independently scored raw records')
    projected_service = []
    for project in PROJECTS:
        cases = [case for case in service['cases'] if case['project'] == project]
        require(len(cases) == 2, 'project does not have two complete service cases')
        states = {}
        for state in ('instrumented', 'observer_disabled'):
            stats = {base: mean(case['median_operation_seconds'][base + ':' + state] for case in cases)
                     for base in ('counter', 'hact_selected')}
            stats['ratio'] = stats['hact_selected'] / stats['counter']
            states[state] = stats
        projected_service.append({'project': project, 'states': states})
    require(data['service'] == projected_service, 'manuscript service aggregation differs')
    ranges = {}
    for state in ('instrumented', 'observer_disabled'):
        ratios = [ratio for case in service['cases'] for ratio in case['selected_hact_vs_counter'][state]['paired_ratios']]
        ranges[state] = [min(ratios), max(ratios)]
    require(data['service_paired_ratio_ranges'] == ranges
            and data['service_all_paired_ratios_above_one'] == service['all_selected_hact_slower'],
            'manuscript paired-range/winner claim differs')
    require(data['answer_checks'] == service['raw_query_rows_checked'], 'manuscript answer count differs')
    expected_sources = {'results/v12/schedule_shift/SUMMARY.json',
                        'results/v12/schedule_generated_metadata/SUMMARY.json',
                        'results/v12/service_ablation/raw.json', 'results/v12/robustness.json',
                        'results/v12/fixed_batch.json'}
    require(set(data['source_sha256']) == expected_sources, 'manuscript source binding omitted')
    verify_hashes(root, data['source_sha256'])
    return True


def audit_projection(initial, repaired, service, root=ROOT):
    path = root / 'results/v12/manuscript_numbers.json'
    data = read(path)
    validate_manuscript_numbers(data, initial, repaired, service, root)
    latex = (root / 'paper/v12_followup_results.tex').read_text()
    names = dict(zip(PROJECTS, ('Click', 'Jinja', 'Pluggy', 'attrs', 'ExceptionGroup')))
    shift_table = latex.split('\\label{tab:v12-shifts}', 1)[1].split('\\bottomrule', 1)[0]
    service_table = latex.split('\\label{tab:v12-observer}', 1)[1].split('\\bottomrule', 1)[0]
    def cells(table, label):
        lines = [line for line in table.splitlines() if line.startswith(label + ' & ')]
        require(len(lines) == 1, 'missing/duplicated manuscript table row')
        return [part.strip().removesuffix('\\\\').strip() for part in lines[0].split('&')[1:]]
    for project in PROJECTS:
        gains = {row['policy']: row['gains']['historical'] for row in data['schedule'] if row['project'] == project}
        ranges = []
        for policy in POLICIES:
            low, high = min(gains[policy]), max(gains[policy])
            ranges.append(f'{low:.2f}' if low == high else f'{low:.2f} to {high:.2f}')
        require(cells(shift_table, names[project]) == ranges, 'rendered dispatch table differs')
        states = next(row['states'] for row in data['service'] if row['project'] == project)
        off, on = states['observer_disabled'], states['instrumented']
        expected = [f"{1000 * off['counter']:.1f}", f"{1000 * off['hact_selected']:.1f}",
                    f"{on['ratio']:.2f}", f"{off['ratio']:.2f}"]
        require(cells(service_table, names[project]) == expected, 'rendered service table differs')
    return {'status': 'PASS', 'manuscript_numbers_sha256': sha(path),
            'rendered_tables_sha256': sha(root / 'paper/v12_followup_results.tex'),
            'schedule_outcomes': data['schedule_outcomes'],
            'actual_scheduling_check_executions': data['actual_scheduling_check_executions'],
            'admitted_scheduling_check_executions': data['admitted_scheduling_check_executions']}


def build_report(root=ROOT):
    schedule = audit_schedule(root)
    repair = audit_schedule(root, 'results/v12/schedule_generated_metadata')
    initial_void = [row for row in schedule['rows'] if row['status'] != 'PASS']
    require(len(initial_void) == 6 and all(row['project'] == 'exceptiongroup' and row['status'] == 'VOID'
            and row['reason'] == 'executed production source mismatch' for row in initial_void),
            'six original source-provenance exclusions were not preserved')
    require(repair['status_counts'] == {'PASS': 6}, 'generated-metadata follow-up incomplete or ineligible')
    admitted = [row for row in schedule['rows'] if row['status'] == 'PASS'] + repair['rows']
    require(len(admitted) == 30 and {(row['project'], row['policy'], row['seed']) for row in admitted}
            == {(project, policy, seed) for project in PROJECTS for policy in POLICIES for seed in SEEDS},
            'combined admitted schedule cohort clipped or duplicated')
    for project in PROJECTS:
        baseline = read(root / 'results/v11/public_checks_normalized' / project / 'run_3/pytest_evidence.json')
        counts = dict(Counter(row['status'] for row in baseline['records'].values()))
        require(all(row['counts'] == counts for row in admitted if row['project'] == project),
                'admitted dispatch changed original outcome counts')
    service_finished = datetime.fromisoformat(read(root / 'results/v12/service_ablation/raw.json')['finished_utc'])
    child_receipts = read(root / 'results/v12/schedule_generated_metadata/SUMMARY.json')['runs']
    require(all(datetime.fromisoformat(row['started_at']) >= service_finished for row in child_receipts),
            'repair process overlapped service timing')
    combined_counts = {}
    for policy in POLICIES:
        rows = [row for row in admitted if row['policy'] == policy]
        combined_counts[policy] = {role: dict(Counter('win' if row['costs'][role] < row['costs']['original'] else
            'loss' if row['costs'][role] > row['costs']['original'] else 'tie' for row in rows))
            for role in LAYOUTS if role != 'original'}
    service = audit_service(root)
    projection = audit_projection(schedule, repair, service, root)
    return {'schema': 'hact-v12-independent-followup-audit-1', 'audit_status': 'PASS',
            'independence': 'own literal JSON tree scorer and page/wire reconstruction; independent v11 raw-record semantic oracle; no benchmark execution',
            'schedule': schedule, 'schedule_generated_metadata': repair,
            'combined_schedule': {'attempted_processes': 36, 'admitted_runs': 30, 'initial_void_runs': 6,
                                 'wins_ties_losses_vs_original': combined_counts, 'rows': admitted},
            'service_ablation': service, 'manuscript_projection': projection,
            'interpretation': 'audit consistency is distinct from experimental eligibility or performance; all VOID/UNKNOWN outcomes retained',
            'auditor_sha256': sha(Path(__file__)),
            'semantic_oracle_auditor_sha256': sha(root / 'audit/check_v11_compiler.py')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    report = build_report()
    encoded = json.dumps(report, indent=2, sort_keys=True) + '\n'
    if args.write:
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT.write_text(encoded)
    else:
        require(OUTPUT.is_file() and OUTPUT.read_text() == encoded, 'persisted independent audit differs')
    print(json.dumps({'audit_status': 'PASS', 'schedule': report['schedule']['status_counts'],
                      'service_query_rows_checked': report['service_ablation']['raw_query_rows_checked']}))


if __name__ == '__main__':
    main()
