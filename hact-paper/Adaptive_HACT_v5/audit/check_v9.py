"""Independent arithmetic, input-digest and generated-manuscript audit.

No imports from services, optimizers or codecs. Default mode verifies frozen
records and generated LaTeX. --write explicitly refreshes derived files.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from statistics import mean

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return json.loads((ROOT / path).read_text())


def serialized(value):
    return json.dumps(value, indent=2, sort_keys=True) + '\n'


def reconstruct():
    entries = []
    def check(name, actual, expected):
        ok = (math.isclose(actual, expected, rel_tol=1e-10, abs_tol=1e-10)
              if type(actual) is float and type(expected) in (int, float)
              else actual == expected)
        entries.append({'claim': name, 'status': 'OK' if ok else 'MISMATCH'})
    eq = read('results/v9/service_equivalence.json')
    comparisons = eq['comparisons']
    for i, row in enumerate(comparisons):
        check('reference/semantic equality row %d' % i,
              all(row[k] for k in ('reference_equal', 'semantic_equal', 'epoch_equal',
                                  'total_waves_equal', 'unknown_disclosure_equal',
                                  'kernel_verdict_agrees', 'equal')), True)
        check('semantic digest row %d' % i, row['hact_digest'], row['flat_digest'])
    matches = sum(bool(r['equal']) for r in comparisons)
    check('equivalence summary count', eq['summary']['equal'], matches)
    check('equivalence comparisons count', eq['summary']['comparisons'], len(comparisons))
    check('complete oracle matrix', len(comparisons), len(eq['corpus']) * len(eq['queries']) * 2)
    check('all reference answers agree', eq['summary']['all_equal'], matches == len(comparisons))
    check('layout invariance', all(r['invariant'] for r in eq['layout_invariance']), True)

    study = read('results/v9/real_query_cost_study.json')
    for report in (eq, study):
        for source in report['inputs']:
            path = ROOT / source['path']
            if not path.resolve().is_relative_to(ROOT.resolve()):
                raise ValueError('unsafe input path')
            raw = path.read_bytes()
            check('input bytes ' + source['path'], len(raw), source['bytes'])
            check('input SHA256 ' + source['path'], hashlib.sha256(raw).hexdigest(), source['sha256'])
    rows, setups = study['rows'], study['setups']
    setup_index = {s['id']: s for s in setups}
    check('setup identities unique', len(setup_index), len(setups))
    for row in rows:
        check('study semantic digest', row['equal_semantics'], row['hact_digest'] == row['flat_digest'])
        setup = setup_index[row['setup_id']]
        for arm in ('hact', 'flat'):
            costs, arrival = row[arm], row[arm + '_arrival']
            processing = sum(costs[k] for k in ('aggregation_seconds', 'encode_seconds', 'decode_seconds'))
            allocation = (setup[arm]['index_build_seconds'] + setup[arm]['index_maintenance_seconds']) / setup['query_count']
            transfer = costs['compressed_answer_bytes'] / study['link_bytes_per_second']
            check('query processing seconds', arrival['query_processing_seconds'], processing)
            check('uniform setup allocation', arrival['allocated_setup_seconds'], allocation)
            check('wire-only modeled transfer', arrival['transfer_seconds_at_declared_rate'], transfer)
            check('arithmetic arrival', arrival['total_seconds'], arrival['archived_completion_seconds'] + allocation + processing + transfer)
            check('modeled arrival disclosed', arrival['simulated'], True)
            check('real cache event', costs['cache_hits'], int(row['cache_phase'] == 'warm'))
    for setup in setups:
        members = [r for r in rows if r['setup_id'] == setup['id']]
        check('setup query count', setup['query_count'], len(members))
    for arm, summary_key in [('hact', 'hact'), ('flat', 'indexed_flat')]:
        for key, value in study['summary'][summary_key].items():
            check('summary ' + arm + '/' + key, value, sum(r[arm][key] for r in rows))
    for family in study['decision_table']:
        members = [r for r in rows if r['query_id'] == family['query_family']]
        hb = sum(r['hact']['compressed_answer_bytes'] for r in members)
        fb = sum(r['flat']['compressed_answer_bytes'] for r in members)
        ht = sum(r['hact_arrival']['total_seconds'] for r in members)
        ft = sum(r['flat_arrival']['total_seconds'] for r in members)
        equal = all(r['equal_semantics'] for r in members)
        for key, actual in [('n_queries', len(members)), ('hact_wire_bytes', hb), ('flat_wire_bytes', fb),
                            ('hact_modeled_arrival_seconds_total', ht), ('flat_modeled_arrival_seconds_total', ft),
                            ('equal_semantics_all', equal), ('bytes_better', hb < fb), ('time_better', ht < ft),
                            ('hact_beneficial', equal and hb < fb and ht < ft)]:
            check('family ' + family['query_family'] + '/' + key, family[key], actual)
    flat_agg = sum(r['flat']['aggregation_seconds'] for r in rows)
    hact_agg = sum(r['hact']['aggregation_seconds'] for r in rows)
    flat_total = sum(r['flat_arrival']['total_seconds'] for r in rows)
    fraction = flat_agg / flat_total
    ratio = flat_agg / hact_agg
    check('Amdahl fraction', study['amdahl']['f_measured'], fraction)
    check('Amdahl observed ratio', study['amdahl']['predicted_speedup_at_observed_ratio'], 1 / (1 - fraction + fraction / ratio))
    check('Amdahl infinite acceleration ceiling', study['amdahl']['unbounded_aggregation_speedup_ceiling'], 1 / (1 - fraction))
    check('Amdahl latency reduction', study['amdahl']['maximum_latency_reduction_percent'], 100 * fraction)

    old = read('results/v8/higher_order_ablation.json')
    ablation = old['rows']
    clustered = [r for r in ablation if r['workload']['kind'] == 'cluster']
    def penalty(group, method):
        return mean(100 * (r['heldout_totals'][method] / r['heldout_totals']['rung2_cluster'] - 1) for r in group)
    small = old['summary']['exhaustive_small_scale']
    small_gap = max(100 * (r['rung2_cluster'] / r['best_cost'] - 1) for r in small)
    old_cost = read('results/v8/real_query_cost_study.json')
    old_fraction = old_cost['amdahl']['flat_cpu_seconds'] / old_cost['amdahl']['flat_total_seconds']
    corrections = {'schema': 'v9-numerical-corrections-1',
        'scope': 'reanalysis of unchanged frozen v8 rows; not new ablation trials',
        'frequency_penalty_all_percent': penalty(ablation, 'rung1_frequency'),
        'frequency_penalty_cluster_percent': penalty(clustered, 'rung1_frequency'),
        'original_order_exact_penalty_all_percent': penalty(ablation, 'rung4_exact_tree_dp'),
        'original_order_exact_penalty_cluster_percent': penalty(clustered, 'rung4_exact_tree_dp'),
        'maximum_small_fixed_topology_gap_percent': small_gap,
        'historical_unbounded_aggregation_speedup_percent': 100 * (1 / (1 - old_fraction) - 1),
        'cluster_higher_order_wins': sum(r['heldout_totals']['rung3_wave_improvement'] < r['heldout_totals']['rung2_cluster'] for r in clustered),
        'cluster_workloads': len(clustered)}
    numbers = {
        'VnineOracleMatches': str(matches), 'VnineInvariantChecks': str(len(eq['layout_invariance'])),
        'VnineStudyRows': str(len(rows)), 'VnineSetups': str(len(setups)),
        'VnineCacheHits': str(study['summary']['hact']['cache_hits']),
        'VnineWireBytes': format(sum(r['hact']['compressed_answer_bytes'] for r in rows), ','),
        'VnineHactStorage': format(sum(s['hact']['storage_bytes'] for s in setups), ','),
        'VnineFlatStorage': format(sum(s['flat']['storage_bytes'] for s in setups), ','),
        'VnineHactSetupSeconds': '%.4f' % sum(s['hact']['index_build_seconds'] + s['hact']['index_maintenance_seconds'] for s in setups),
        'VnineFlatSetupSeconds': '%.4f' % sum(s['flat']['index_build_seconds'] + s['flat']['index_maintenance_seconds'] for s in setups),
        'VnineAggregationMaxReduction': '%.2f' % (100 * fraction),
        'VnineFrequencyClusterPenalty': '%.2f' % corrections['frequency_penalty_cluster_percent'],
        'VnineFrequencyAllPenalty': '%.2f' % corrections['frequency_penalty_all_percent'],
        'VnineExactAllPenalty': '%.2f' % corrections['original_order_exact_penalty_all_percent'],
        'VnineExactClusterPenalty': '%.2f' % corrections['original_order_exact_penalty_cluster_percent'],
        'VnineSmallGap': '%.2f' % small_gap,
        'VnineOldAmdahlCeiling': '%.2f' % corrections['historical_unbounded_aggregation_speedup_percent'],
        'VnineHigherOrderWins': str(corrections['cluster_higher_order_wins']),
        'VnineHigherOrderCases': str(len(clustered))}
    macros = '% Generated by audit.check_v9; edit data or generator, then verify.\n' + ''.join(
        '\\newcommand{\\%s}{%s}\n' % (key, value) for key, value in numbers.items())
    table = '% Generated by audit.check_v9; compressed answer bytes only.\n'
    for family in study['decision_table']:
        table += '%s & %d & %s & %s & %s\\\\\n' % (family['query_family'], family['n_queries'],
            format(family['hact_wire_bytes'], ','), format(family['flat_wire_bytes'], ','),
            'yes' if family['hact_beneficial'] else 'no')
    paragraph = r'''% Generated signed interpretation of the frozen ablation.
The direct-wave search beats pairwise seriation in \VnineHigherOrderWins{} of
\VnineHigherOrderCases{} clustered workloads. Frequency ordering has a mean
cost penalty of \VnineFrequencyClusterPenalty\% on the clustered subset and
\VnineFrequencyAllPenalty\% across all workloads. Original-order exact DP has
cost penalties of \VnineExactClusterPenalty\% and \VnineExactAllPenalty\%,
respectively, against learned-order balanced trees. This comparison changes
both order and shape and therefore cannot bound same-order tree-shape headroom.
At $n=9$, the maximum fitted-sample gap is \VnineSmallGap\%, over permutations
of the fixed compact-balanced topology only. It is neither a global optimum
over tree shapes nor a held-out guarantee. These results do not establish a
beyond-pairwise advantage for the deployed algorithm.
'''
    outputs = {'results/v9/numerical_corrections.json': serialized(corrections),
               'paper/generated_v9/macros.tex': macros,
               'paper/generated_v9/query_rows.tex': table,
               'paper/generated_v9/ablation.tex': paragraph}
    return entries, outputs


def verify(write=False):
    entries, outputs = reconstruct()
    if write and any(e['status'] != 'OK' for e in entries):
        raise ValueError('refuse to generate from inconsistent records')
    for relative, expected in outputs.items():
        path = ROOT / relative
        if write:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(expected)
        entries.append({'claim': relative,
                        'status': 'OK' if path.is_file() and path.read_text() == expected else 'MISMATCH'})
    result = {'schema': 'v9-manuscript-audit-1',
              'status': 'PASS' if all(e['status'] == 'OK' for e in entries) else 'FAIL',
              'checks': len(entries), 'entries': entries,
              'scope': 'independent arithmetic and generated result prose; not checker/codec certification'}
    if write:
        (ROOT / 'results/v9/audit.json').write_text(serialized(result))
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--write', action='store_true')
    result = verify(parser.parse_args().write)
    print(json.dumps({k: v for k, v in result.items() if k != 'entries'}, indent=2))
    for entry in result['entries']:
        if entry['status'] != 'OK':
            print(entry)
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
