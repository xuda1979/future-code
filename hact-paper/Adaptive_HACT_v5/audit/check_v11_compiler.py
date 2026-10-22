"""Independent v11 compiler arithmetic, raw-normalization and split audit.

Reads persisted JSON and reconstructs ancestor packet prices directly. Imports
no Layout, compiler, refiner, producer scoring helper or HACT model. PASS means
that the checked claims agree with retained records, not that all experiments
succeeded, or that the sampling frame permits population-level inference.
"""
from __future__ import annotations
import argparse
from collections import Counter
from datetime import datetime
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = Path('results/v11/public_compiler')
NORMALIZED = Path('results/v11/public_checks_normalized')


def read_json(path):
    return json.loads(Path(path).read_text())


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def verify_entry(root, entry, *, relative_to=None):
    path = root / entry['path'] if relative_to is None else relative_to
    require(path.is_file(), f'missing bound file: {path}')
    require(sha(path) == entry['sha256'], f'bound file changed: {path}')
    if 'bytes' in entry:
        require(path.stat().st_size == entry['bytes'], f'bound size differs: {path}')


def features(layout):
    """Literal validated tree: prices and each semantic ID's ancestor nodes."""
    registry, order, model = layout['registry'], layout['order'], layout['model']
    n = len(registry)
    require(n > 0 and len(set(registry)) == n, 'invalid semantic registry')
    require(len(order) == n and all(type(i) is int for i in order)
            and set(order) == set(range(n)), 'nonbijective layout order')
    h, s, cap = (model[k] for k in ('header', 'card', 'cap'))
    require(all(type(x) is int and x > 0 for x in (h, s, cap)), 'invalid packet price')
    prices, paths, intervals = [], {}, []

    def visit(node, lo, hi, ancestors):
        require(set(node) == {'lo', 'hi', 'children'}, 'malformed tree node')
        require(type(node['lo']) is int and type(node['hi']) is int
                and (node['lo'], node['hi']) == (lo, hi), 'tree coverage changed')
        children = node['children']
        require(isinstance(children, list), 'children must be a list')
        if not children:
            require(lo == hi, 'non-singleton leaf')
            paths[registry[order[lo]]] = tuple(ancestors)
            return
        price = h + s * len(children)
        require(2 <= len(children) and price <= cap, 'packet arity/cap violated')
        idx = len(prices)
        prices.append(price)
        intervals.append((lo, hi))
        cursor = lo
        for child in children:
            end = child['hi']
            require(cursor <= end <= hi, 'overlap or missing subtree coverage')
            visit(child, cursor, end, (*ancestors, idx))
            cursor = end + 1
        require(cursor == hi + 1, 'incomplete parent coverage')

    visit(layout['tree'], 0, n - 1, ())
    require(set(paths) == set(registry), 'leaf identity omitted')
    return prices, paths, intervals


def score(layout, executed, width=8):
    prices, paths, _ = features(layout)
    require(type(width) is int and width > 0, 'invalid wave width')
    require(len(set(executed)) == len(executed), 'duplicate final completion')
    require(set(executed) <= set(paths), 'foreign final completion')
    total = sum(prices)  # Full initially-unknown tree, including empty epochs.
    for start in range(0, len(executed), width):
        touched = set()
        for cid in executed[start:start + width]:
            touched.update(paths[cid])
        total += sum(prices[i] for i in touched)
    return total


def score_episode(layout, episode, prepared=None):
    prices, paths, _ = features(layout) if prepared is None else prepared
    registry = layout['registry']
    result = sum(prices)
    for wave in episode:
        require(all(type(i) is int and 0 <= i < len(registry) for i in wave), 'invalid synthetic leaf')
        touched = set()
        for i in set(wave):
            touched.update(paths[registry[i]])
        result += sum(prices[i] for i in touched)
    return result


def check_refinement_scope(base, refined, cap):
    require(base['registry'] == refined['registry'] and base['order'] == refined['order']
            and base['model'] == refined['model'], 'refinement changed order/contract')
    def compare(a, b):
        require((a['lo'], a['hi']) == (b['lo'], b['hi']), 'refinement interval changed')
        if not a['children']:
            require(a == b, 'refinement changed a leaf')
        elif a['hi'] - a['lo'] + 1 > cap:
            require(len(a['children']) == len(b['children']), 'large ancestor arity changed')
            for child, replacement in zip(a['children'], b['children']):
                compare(child, replacement)
    compare(base['tree'], refined['tree'])


def normalized_run(root, project, run):
    folder = root / NORMALIZED / project / f'run_{run}'
    evidence, report, receipt = (read_json(folder / (name + '.json'))
                                 for name in ('pytest_evidence', 'report', 'receipt'))
    parent = root / evidence['normalization']['parent_path']
    raw = read_json(parent)
    require(sha(parent) == evidence['normalization']['parent_sha256'], 'raw evidence parent changed')
    require(receipt['evidence_sha256'] == sha(parent), 'raw execution receipt digest differs')
    require(receipt['raw_receipt_sha256'] == sha(parent.with_name('receipt.json')), 'raw receipt parent changed')
    require(report['normalization_parent_sha256'] == sha(parent.with_name('report.json')), 'raw report parent changed')
    restored = dict(evidence)
    restored.pop('normalization')
    require(restored.pop('collected_registry') == raw['registry'], 'collected order lost')
    require(evidence['registry'] == sorted(raw['registry']), 'registry is not canonical sorted IDs')
    restored['registry'] = raw['registry']
    require(restored == raw, 'normalization changed actual completions/phases/records')
    require(receipt['eligible'] and receipt['complete'] and evidence['session_finished'], 'ineligible run')
    registry, executed, records = evidence['registry'], evidence['executed'], evidence['records']
    require(len(registry) == len(set(registry)) and len(executed) == len(set(executed)), 'duplicate IDs')
    require(set(registry) == set(executed) == set(records), 'incomplete declared registry')
    counts = dict.fromkeys(('PASS', 'FAIL', 'UNKNOWN'), 0)
    for record in records.values():
        require(record['status'] in counts, 'invalid retained status')
        counts[record['status']] += 1
    require(all(counts[k] == receipt['counts'].get(k, 0) for k in counts), 'status counts changed')
    require(report['registry_hash'] == hashlib.sha256(canonical(registry)).hexdigest(), 'canonical registry hash differs')
    require(receipt['split'] == ('training', 'training', 'validation', 'heldout', 'heldout')[run], 'split membership differs')
    return evidence, report, counts


def audit_public(root=ROOT):
    directory = root / PUBLIC
    contract = read_json(directory / 'CONTRACT.json')
    require(contract['training_runs'] == [0, 1] and contract['validation_runs'] == [2]
            and contract['heldout_runs'] == [3, 4], 'frozen split changed')
    require(contract['primary_cap'] == 32 and contract['sensitivity_cap'] == 64
            and contract['wave_width'] == 8, 'primary/sensitivity endpoint changed')
    contract_sha = hashlib.sha256(canonical(contract)).hexdigest()
    method = read_json(directory / 'METHOD_MANIFEST.json')
    for path, entry in method.items():
        verify_entry(root, {'path': path, **entry})
    plan = read_json(root / NORMALIZED / 'NORMALIZATION_MANIFEST.json')
    deviation = read_json(directory / 'PROTOCOL_DEVIATION.json')
    require(not deviation['heldout_compiler_costs_opened'], 'deviation after heldout cost inspection')
    require(sha(root / 'results/v11/public_checks/FROZEN_MANIFEST.json') == plan['raw_cohort_manifest_sha256'], 'sampling frame changed')
    frozen = read_json(directory / 'FIT_FROZEN.json')
    require(not frozen['heldout_opened'] and frozen['contract_sha256'] == contract_sha, 'fit freeze invalid')
    frozen_fits = {r['project']: r for r in frozen['projects']}
    summary = read_json(directory / 'SUMMARY.json')
    require(summary['contract'] == contract, 'summary changed frozen contract')
    summary_rows = {r['project']: r for r in summary['projects']}
    rows = []
    for project in contract['projects']:
        project_dir = directory / project
        fit_path = project_dir / 'fit_receipt.json'
        fit, evaluation = read_json(fit_path), read_json(project_dir / 'evaluation.json')
        require(frozen_fits[project]['fit_receipt_sha256'] == sha(fit_path), 'fit changed after freezing')
        require(fit['contract_sha256'] == contract_sha and not fit['heldout_opened'], 'fit contract/holdout state invalid')
        require(datetime.fromisoformat(deviation['at']) <= datetime.fromisoformat(fit['frozen_at'])
                <= datetime.fromisoformat(frozen['at']), 'fit chronology inconsistent')
        for run, paths in fit['input_manifest'].items():
            require(int(run) in (0, 1, 2), 'heldout evidence in fitting receipt')
            for entry in paths.values():
                verify_entry(root, entry)
        require(set(fit['input_manifest']) == {'0', '1', '2'}, 'fit did not bind train/validation only')
        runs = [normalized_run(root, project, i) for i in range(5)]
        registry = runs[0][0]['registry']
        require(all(r[0]['registry'] == registry for r in runs), 'ID set changed across repetitions')
        for key in ('snapshot', 'checker', 'environment', 'registry_hash'):
            require(all(r[1][key] == fit['identity'][key] for r in runs), 'bound run identity differs')
        require(evaluation == summary_rows[project], 'summary differs from project evaluation')
        if project == 'packaging':
            require(fit['status'] == evaluation['status'] == 'UNKNOWN'
                    and not fit['optimization_available'], 'resource failure promoted to success')
            n = len(registry)
            require(n > contract['max_dense_registry']
                    and fit['dense_matrix_lower_bound_bytes'] == 8*n*n
                    and 8*n*n > contract['compiler_memory_budget_bytes'], 'resource admission unsupported')
            verify_entry(root, fit['fallback_layout_manifest'])
            fallback = read_json(root / fit['fallback_layout_manifest']['path'])
            values = [score(fallback, runs[i][0]['executed']) for i in (3, 4)]
            require(values == evaluation['fallback_heldout_per_run_bytes'], 'fallback cost differs')
            rows.append({'project': project, 'optimization_status': 'UNKNOWN',
                         'registry_size': n, 'fallback_bytes': values, 'in_primary': False})
            continue
        require(fit['status'] == evaluation['status'] == 'PASS', 'unexpected project exclusion')
        require(fit['training_runs'] == [0, 1] and fit['validation_runs'] == [2]
                and fit['heldout_runs'] == [3, 4], 'fit split receipt differs')
        require(evaluation['frozen_fit_sha256'] == sha(fit_path), 'evaluation used different fit')
        require(datetime.fromisoformat(frozen['at']) <= datetime.fromisoformat(evaluation['evaluated_at']), 'evaluation preceded freeze')
        for paths in evaluation['input_manifest'].values():
            for entry in paths.values():
                verify_entry(root, entry)
        layouts = {}
        for filename, entry in fit['layout_manifest'].items():
            verify_entry(root, entry, relative_to=project_dir / filename)
            if filename.startswith('layout_'):
                layouts[filename[7:-5]] = read_json(project_dir / filename)
        totals, validation = {}, {}
        for name, layout in layouts.items():
            require(layout['registry'] == registry, 'layout omitted/changed declared IDs')
            scores = [score(layout, r[0]['executed']) for r in runs]
            require(scores[:2] == fit['train_per_run_bytes'][name], 'training byte claim differs')
            require(scores[2] == fit['validation_bytes'][name], 'validation byte claim differs')
            require(scores[3:] == evaluation['heldout_per_run_bytes'][name], 'heldout per-run claim differs')
            totals[name], validation[name] = sum(scores[3:]), scores[2]
            require(totals[name] == evaluation['heldout_total_bytes'][name], 'heldout total differs')
        compact = ('original_compact', 'pairwise_compact')
        choices = {'historical_compact': min(compact, key=validation.get)}
        for cap in (32, 64):
            names = (*compact, *(f'{p}_refined{cap}' for p in compact))
            choices[f'fullwave{cap}'] = min(names, key=validation.get)
            for parent in compact:
                refined = f'{parent}_refined{cap}'
                check_refinement_scope(layouts[parent], layouts[refined], cap)
                require(sum(fit['train_per_run_bytes'][refined]) <= sum(fit['train_per_run_bytes'][parent]), 'training monotonicity failed')
        require(fit['selected'] == evaluation['selected'] == choices, 'validation selection/tie rule differs')
        for alias, winner in choices.items():
            totals[alias] = totals[winner]
            require(totals[alias] == evaluation['heldout_total_bytes'][alias], 'selected total differs')
        base = totals['historical_compact']
        primary = (base - totals['fullwave32']) / base
        sensitivity = (base - totals['fullwave64']) / base
        require(primary == evaluation['primary_saving_fraction']
                and sensitivity == evaluation['sensitivity_saving_fraction'], 'fraction claim differs')
        rows.append({'project': project, 'optimization_status': 'PASS', 'registry_size': len(registry),
                     'selected': choices, 'heldout_total_bytes': totals,
                     'primary_saving_fraction': primary, 'secondary_saving_fraction': sensitivity,
                     'in_primary': True})
    eligible = [r for r in rows if r['in_primary']]
    counts = {'wins': sum(r['primary_saving_fraction'] > 0 for r in eligible),
              'ties': sum(r['primary_saving_fraction'] == 0 for r in eligible),
              'losses': sum(r['primary_saving_fraction'] < 0 for r in eligible)}
    require(summary['primary'] == counts and summary['eligible_projects'] == len(eligible)
            and summary['requested_projects'] == len(rows) and summary['status'] == 'UNKNOWN', 'project summary hid missing optimization')
    return {'primary': counts, 'eligible_projects': len(eligible), 'requested_projects': len(rows),
            'optimization_cohort_status': summary['status'], 'projects': rows,
            'chronology': 'hash-bound local receipts support freeze before heldout scoring; not external preregistration',
            'normalization': 'all 30 derivatives preserve raw execution order, phases and records exactly',
            'environment_limit': 'report environment IDs bind Python/platform only; dependency repair must be separately disclosed'}


def synthetic_episodes(n, family, seed, sizes):
    """Independent regeneration of the frozen published sampling specification."""
    import numpy as np
    rng = np.random.default_rng(seed)
    latent = [int(i) for i in rng.permutation(n)]
    groups = [latent[i:i+8] for i in range(0, n, 8)]
    output = []
    for size in sizes:
        episodes = []
        for _ in range(size):
            if family == 'cluster':
                wave = list(groups[int(rng.integers(len(groups)))])
                if rng.random() < .12:
                    wave.append(int(rng.integers(n)))
            elif family == 'independent':
                wave = np.flatnonzero(rng.random(n) < 8/n).tolist()
            elif family == 'global':
                wave = list(range(n))
            else:
                raise AssertionError('unknown frozen workload family')
            episodes.append([sorted(set(wave))])
        output.append(episodes)
    return output


def audit_synthetic(root=ROOT):
    directory = root / 'results/v11'
    summary = read_json(directory / 'compiler_study.json')
    require(summary['contract']['primary_cap'] == 32 and summary['contract']['sensitivity_cap'] == 64, 'synthetic endpoint changed')
    require(hashlib.sha256(canonical(summary['contract'])).hexdigest() == summary['contract_sha256'], 'synthetic contract hash differs')
    for name, digest in summary['input_sha256'].items():
        require(sha(root / name) == digest, 'synthetic source changed: '+name)
    rows = []
    for filename in summary['case_files']:
        case = read_json(directory / filename)
        n, family, seed = (case['workload'][k] for k in ('n','kind','seed'))
        splits = synthetic_episodes(n, family, seed, (128,128,256))
        for key, episodes in zip(('train','validation','heldout'), splits):
            require(hashlib.sha256(canonical(episodes)).hexdigest() == case['split_sha256'][key], 'synthetic split regeneration differs')
        totals, validation = {}, {}
        for name, layout in case['layouts'].items():
            prepared = features(layout)
            totals[name] = sum(score_episode(layout, ep, prepared) for ep in splits[2])
            validation[name] = sum(score_episode(layout, ep, prepared) for ep in splits[1])
            require(totals[name] == case['heldout_total_bytes'][name], 'synthetic objective differs')
        compact = ('original_compact','pairwise_compact')
        choices = {'historical_practical': min(compact, key=validation.get)}
        for cap in (32,64):
            names = (*compact, *(f'{p}_refined{cap}' for p in compact))
            choices[f'fullwave{cap}'] = min(names, key=validation.get)
            for parent in compact:
                check_refinement_scope(case['layouts'][parent], case['layouts'][f'{parent}_refined{cap}'], cap)
        require(choices == case['selected'], 'synthetic validation selection differs')
        for alias, winner in choices.items():
            totals[alias] = totals[winner]
            require(totals[alias] == case['heldout_total_bytes'][alias], 'synthetic selected objective differs')
        base = totals['historical_practical']
        p, s = ((base-totals[f'fullwave{cap}'])/base for cap in (32,64))
        require(p == case['primary_saving_fraction'] and s == case['sensitivity_saving_fraction'], 'synthetic saving fraction differs')
        rows.append({'file': filename, 'primary': p, 'secondary': s})
    for endpoint, key in (('primary','primary'), ('sensitivity','secondary')):
        values = [r[key] for r in rows]
        require(summary[endpoint]['wins'] == sum(v>0 for v in values)
                and summary[endpoint]['ties'] == sum(v==0 for v in values)
                and summary[endpoint]['losses'] == sum(v<0 for v in values), 'synthetic aggregate differs')
    return {'cases': len(rows), 'primary': summary['primary'], 'secondary': summary['sensitivity']}


def raw_service_answer(evidence, report, epoch, query):
    """Independent canonical semantics for the seven frozen diagnostic queries."""
    registry = evidence['registry']
    completed = evidence['executed'][:epoch*8]
    records = {cid:evidence['records'][cid] for cid in completed}
    status = lambda cid: records[cid]['status'] if cid in records else 'UNKNOWN'
    if query == 'Q5':
        if epoch == 0:
            return {'refused':True, 'reason':'wave beyond stated epoch', 'wave':0, 'epoch':0}
        members = evidence['executed'][:8]
        counts = dict.fromkeys(('PASS','FAIL','UNKNOWN'),0)
        for cid in members:
            counts[status(cid)] += 1
        return {'refused':False, 'wave':0, 'members':members, 'counts':counts,
                'wall_seconds_total':sum(evidence['records'][cid].get('wall_seconds',0.0) for cid in members)}
    selected = list(registry)
    if query == 'Q2':
        selected = [cid for cid in registry if status(cid)=='FAIL']
    elif query == 'Q3':
        selected = [cid for cid in registry if cid not in records]
    elif query in ('Q6a','Q6b'):
        def is_unit(cid):
            part = cid.split('::',1)[0]
            return '/tests/' in part or part.startswith('tests/')
        selected = [cid for cid in registry if is_unit(cid)==(query=='Q6a')]
    if query == 'Q2':
        failing, groups = [], {}
        for cid in selected:
            record = records[cid]
            phases = {name:{'outcome':(record.get('phases',{}).get(name) or {}).get('outcome')}
                      for name in ('setup','call','teardown') if name in (record.get('phases') or {})}
            failing.append({'id':cid, 'phase_outcomes':phases,
                            'context':record.get('failure') or '', 'wall_seconds':record.get('wall_seconds')})
            groups.setdefault(cid.split('::',1)[0],[]).append(cid)
        return {'failing_count':len(failing), 'failing':failing,
                'groups':{key:sorted(value) for key,value in sorted(groups.items())}}
    if query == 'Q4':
        ran = [cid for cid in selected if cid in records]
        missing = [cid for cid in selected if cid not in records]
        passed = all(status(cid)=='PASS' for cid in selected)
        return {'declared':len(selected), 'declared_ids':selected,
                'executed':len(ran), 'executed_ids':ran, 'missing':missing,
                'all_declared_passed':passed,
                'eligible_authorization':bool(report.get('locally_authorized')) and passed,
                'scope':'All declared checks passed for the declared contract; this is '
                        'not a claim that the check set suffices for arbitrary program correctness.'}
    require(query in ('Q1','Q3','Q6a','Q6b'), 'unknown frozen query')
    counts = dict.fromkeys(('PASS','FAIL','UNKNOWN'),0)
    for cid in selected:
        counts[status(cid)] += 1
    return {'required':len(selected), 'counts':counts,
            'verdict':'FAIL' if counts['FAIL'] else 'UNKNOWN' if counts['UNKNOWN'] else 'PASS',
            'unfinished':[cid for cid in selected if cid not in records]}


def audit_service(root=ROOT):
    import random
    from statistics import median
    data = read_json(root/'results/v11/service_study.json')
    manifest_path = root/PUBLIC/'SERVICE_CASES.json'
    require(data['input_manifest_sha256']==sha(manifest_path), 'service input manifest changed')
    require(data['status']=='UNKNOWN' and data['repeats']==3 and data['seed']==20261021,
            'service unknown or repeated protocol changed')
    rng = random.Random(20261021)
    cases, checked = [], 0
    for case in data['cases']:
        for name in ('evidence','report','layout'):
            require(case['input_hashes'][name]==sha(root/case[name]), 'service case input changed')
        if case['project']=='packaging':
            require(case['status']=='UNKNOWN' and not case['repetitions'] and case['n']>2048,
                    'resource-excluded service case imputed')
            cases.append({'case':case['case'],'status':'UNKNOWN','measured':False})
            continue
        require(case['status']=='PASS' and len(case['repetitions'])==3, 'service case missing execution')
        evidence, report = read_json(root/case['evidence']), read_json(root/case['report'])
        waves = (len(evidence['executed'])+7)//8
        epochs = sorted({0,max(1,waves//2),waves})
        queries = ('Q1','Q2','Q3','Q4','Q5','Q6a','Q6b')
        keys = [(e,q,p) for e in epochs for q in queries for p in ('cold','warm')]
        expected = {(e,q):hashlib.sha256(canonical(raw_service_answer(evidence,report,e,q))).hexdigest()
                    for e in epochs for q in queries}
        times = {arm:[] for arm in ('indexed','counter','hact_original','hact_selected')}
        for repetition in case['repetitions']:
            arms = ['indexed','counter','hact_original','hact_selected']
            rng.shuffle(arms)
            require(repetition['arm_order']==arms, 'seeded paired arm order differs')
            require([x['arm'] for x in repetition['executions']]==arms, 'actual arm order differs')
            signatures = []
            for execution in repetition['executions']:
                require(execution['status']=='PASS','service arm failure hidden')
                rows, costs = execution['queries'],execution['costs']
                require([(r['epoch'],r['query'],r['phase']) for r in rows]==keys,'service request sequence differs')
                for row in rows:
                    require(row['semantic_sha256']==expected[(row['epoch'],row['query'])],
                            'independent raw-record service answer differs')
                    require(row['seconds']>=0 and row['pages']>0 and row['wire_bytes']>0,
                            'invalid measured query row')
                require(execution['query_seconds']==sum(r['seconds'] for r in rows),'query time sum differs')
                require(execution['service_operation_seconds']+1e-8>=execution['query_seconds']
                        +costs['index_build_seconds']+costs['index_maintenance_seconds'],
                        'whole-trajectory cost omitted stages')
                require(costs['encode_bytes']==sum(r['wire_bytes'] for r in rows)
                        and costs['decode_bytes']==sum(r['raw_bytes'] for r in rows)
                        and costs['pages']==sum(r['pages'] for r in rows),'codec ledger differs')
                require(costs['cache_hits']==21 and costs['cache_misses']==21,'cold/warm queries not exercised')
                signatures.append([(r['epoch'],r['query'],r['phase'],r['semantic_sha256'],
                                    r['raw_bytes'],r['wire_bytes'],r['pages']) for r in rows])
                checked += len(rows)
                times[execution['arm']].append(execution['service_operation_seconds'])
            require(all(s==signatures[0] for s in signatures),'matched answer/codec equality failed')
        medians = {arm:median(values) for arm,values in times.items()}
        cases.append({'case':case['case'],'status':'PASS','measured':True,
                      'median_operation_seconds':medians,
                      'selected_over_counter_ratio':medians['hact_selected']/medians['counter']})
    require(len(cases)==12 and sum(c['measured'] for c in cases)==10,'service cohort clipped')
    return {'status':'UNKNOWN','admitted_cases':10,'resource_unknown_cases':2,
            'raw_answer_and_codec_rows_checked':checked,'cases':cases,
            'scope':'independent raw semantic reconstruction and arithmetic; equal codec bytes are conformance'}


def audit_regressions(root=ROOT):
    path = root/'results/v11/regression_costs.json'
    data = read_json(path)
    source_path = root/'results/v11/public_regressions/COLLECTION_SUMMARY.json'
    source = read_json(source_path)
    require(data['selection_summary_sha256']==sha(source_path)
            and data['fit_freeze_sha256']==sha(root/PUBLIC/'FIT_FROZEN.json'), 'regression input identities changed')
    by_case = {r['case_id']:r for r in data['rows']}
    checked = []
    for case in source['cases']:
        row = by_case[case['case_id']]
        if not case['eligible_for_paired_costs']:
            require(row['status']=='VOID' and row.get('reason'), 'ineligible source case promoted')
            checked.append({'case':case['case_id'],'status':'VOID'})
            continue
        base = root/'results/v11/public_regressions'/case['project']/case['case_id']
        evidence = read_json(base/'pytest_evidence.json')
        require(row['evidence_sha256']==sha(base/'pytest_evidence.json'), 'regression evidence changed')
        require(len(evidence['executed'])==len(set(evidence['executed']))
                and set(evidence['records'])==set(evidence['executed'])<=set(evidence['registry']), 'invalid regression completion set')
        if case['project']=='packaging':
            require(row['status']=='UNKNOWN', 'large source case promoted')
            layout_path = root/PUBLIC/case['project']/'service_fallback_layout.json'
            require(row['layout_sha256']==sha(layout_path),'fallback source layout changed')
            require(row['fallback_cost']['total_bytes']==score(read_json(layout_path),evidence['executed']), 'fallback source cost differs')
            checked.append({'case':case['case_id'],'status':'UNKNOWN'})
            continue
        values = {}
        for arm,filename in (('historical','historical_layout.json'),('primary32','selected_layout.json'),
                             ('secondary64','selected_layout_sensitivity.json')):
            layout_path = root/PUBLIC/case['project']/filename
            require(row['layout_sha256'][arm]==sha(layout_path),'source transfer layout changed')
            layout = read_json(layout_path)
            require(set(layout['registry'])==set(evidence['registry']),'source transfer registry clipped')
            value = score(layout,evidence['executed'])
            cold = sum(features(layout)[0])
            require(row['costs'][arm]=={'construction_bytes':cold,'refresh_bytes':value-cold,
                    'total_bytes':value,'waves':(len(evidence['executed'])+7)//8},'source transfer byte ledger differs')
            values[arm] = value
        p = 1-values['primary32']/values['historical']
        s = 1-values['secondary64']/values['historical']
        require(p==row['primary_saving_fraction'] and s==row['secondary_saving_fraction'], 'source transfer fraction differs')
        checked.append({'case':case['case_id'],'status':'PASS','primary_saving_fraction':p,
                        'secondary_saving_fraction':s,'total_bytes':values})
    valid = [r for r in checked if r['status']=='PASS']
    counts = {'wins':sum(r['primary_saving_fraction']>0 for r in valid),
              'ties':sum(r['primary_saving_fraction']==0 for r in valid),
              'losses':sum(r['primary_saving_fraction']<0 for r in valid)}
    require(data['primary']==counts and data['attempted']==len(checked)
            and data['compared']==len(valid), 'source case aggregate differs')
    return {'attempted':len(checked),'compared':len(valid),'primary':counts,'rows':checked}


def build_report(root=ROOT):
    return {'schema': 'hact-v11-independent-compiler-audit-1', 'status': 'PASS',
            'independent_path': 'raw JSON, literal tree/ancestor pricing, no producer scoring imports',
            'public': audit_public(root), 'synthetic': audit_synthetic(root),
            'service':audit_service(root), 'source_transfer':audit_regressions(root),
            'scope': 'arithmetic, normalization, fit receipts and restricted-scope conformance; not human review or project-population inference'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    report = build_report()
    if args.output:
        args.output.write_text(json.dumps(report, indent=2, sort_keys=True)+'\n')
        print(json.dumps({'status':'PASS', 'public_primary':report['public']['primary'],
                          'synthetic_cases':report['synthetic']['cases'], 'output':str(args.output)}))
    else:
        print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == '__main__':
    main()
