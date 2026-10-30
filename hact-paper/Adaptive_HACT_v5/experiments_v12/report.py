"""Deterministic manuscript projection from both immutable v12 follow-ups."""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import statistics

ROOT = Path(__file__).resolve().parents[1]
PROJECTS = ('click', 'jinja', 'pluggy', 'attrs', 'exceptiongroup')
NAMES = dict(zip(PROJECTS, ('Click', 'Jinja', 'Pluggy', 'attrs', 'ExceptionGroup')))
TEX = ROOT / 'paper/v12_followup_results.tex'
JSON = ROOT / 'results/v12/manuscript_numbers.json'


def read(name):
    return json.loads((ROOT / name).read_text())


def outcome(a, b):
    return 'win' if a < b else 'tie' if a == b else 'loss'


def project():
    initial = read('results/v12/schedule_shift/SUMMARY.json')
    repair = read('results/v12/schedule_generated_metadata/SUMMARY.json')
    service = read('results/v12/service_ablation/raw.json')
    if not initial['complete'] or not repair['complete']:
        raise ValueError('incomplete scheduling campaign')
    exclusions = [row for row in initial['runs'] if row['status'] != 'PASS']
    if len(initial['runs']) != 30 or len(exclusions) != 6 or any(
            row['project'] != 'exceptiongroup' or row['status'] != 'VOID' for row in exclusions):
        raise ValueError('parent provenance exclusions changed')
    usable = [r for r in initial['runs'] if r['status'] == 'PASS'] + repair['runs']
    if len(usable) != 30 or any(r['status'] != 'PASS' for r in usable):
        raise ValueError('repaired cohort incomplete')
    schedules = []
    by_policy = {}
    for policy in ('files', 'items'):
        selected = [r for r in usable if r['policy'] == policy]
        by_policy[policy] = {base: dict(Counter(outcome(r['costs']['cap32'], r['costs'][base])
                                               for r in selected))
                             for base in ('original', 'historical')}
        for name in PROJECTS:
            rows = sorted((r for r in selected if r['project'] == name), key=lambda r: r['seed'])
            if [r['seed'] for r in rows] != [2026102101, 2026102102, 2026102103]:
                raise ValueError('missing/duplicate schedule seed')
            gains = {base: [100 * (r['costs'][base] - r['costs']['cap32']) / r['costs'][base]
                            for r in rows] for base in ('original', 'historical')}
            secondary = [100 * (r['costs']['historical'] - r['costs']['cap64']) / r['costs']['historical'] for r in rows]
            schedules.append({'project': name, 'policy': policy, 'gains': gains,
                              'cap64_vs_historical': secondary,
                              'costs': [r['costs'] for r in rows]})
    service_rows = []
    checks = 0
    paired = {'instrumented': [], 'observer_disabled': []}
    for name in PROJECTS:
        cases = [r for r in service['cases'] if r['project'] == name]
        if len(cases) != 2 or any(c['status'] != 'PASS' for c in cases):
            raise ValueError('incomplete service project')
        medians = {}
        for state in ('instrumented', 'observer_disabled'):
            values = {'counter': [], 'hact_selected': []}
            for case in cases:
                samples = {arm: [] for arm in values}
                for repeat in case['repetitions']:
                    executions = {r['arm']: r for r in repeat['executions']}
                    checks += sum(len(r['queries']) for r in repeat['executions']) if state == 'instrumented' else 0
                    for arm in samples:
                        run = executions[arm + ':' + state]
                        total = sum(op['seconds'] for op in run['operations'])
                        if total != run['service_operation_seconds'] or total <= 0:
                            raise ValueError('invalid measured operation sum')
                        samples[arm].append(total)
                    paired[state].append(samples['hact_selected'][-1] / samples['counter'][-1])
                if any(len(v) != 3 for v in samples.values()):
                    raise ValueError('wrong number of timing repeats')
                for arm in values:
                    values[arm].append(statistics.median(samples[arm]))
            medians[state] = {arm: statistics.mean(v) for arm, v in values.items()}
            medians[state]['ratio'] = medians[state]['hact_selected'] / medians[state]['counter']
        service_rows.append({'project': name, 'states': medians})
    unknown = [c for c in service['cases'] if c['status'] != 'PASS']
    if len(unknown) != 2 or any(c['project'] != 'packaging' or c['status'] != 'UNKNOWN' for c in unknown):
        raise ValueError('resource exclusions changed')
    sources = ('results/v12/schedule_shift/SUMMARY.json',
               'results/v12/schedule_generated_metadata/SUMMARY.json',
               'results/v12/service_ablation/raw.json', 'results/v12/robustness.json',
               'results/v12/fixed_batch.json')
    return {'schema': 'hact-v12-manuscript-numbers-1', 'schedule': schedules,
            'schedule_outcomes': by_policy, 'initial_void': len(exclusions),
            'actual_scheduling_processes': len(initial['runs']) + len(repair['runs']),
            'actual_scheduling_check_executions': sum(r['n'] for r in usable) + 6 * 102,
            'admitted_scheduling_check_executions': sum(r['n'] for r in usable),
            'service': service_rows, 'answer_checks': checks,
            'service_paired_ratio_ranges': {state: [min(v), max(v)] for state, v in paired.items()},
            'service_all_paired_ratios_above_one': {state: all(x > 1 for x in v) for state, v in paired.items()},
            'source_sha256': {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in sources}}


def range_tex(values):
    low, high = min(values), max(values)
    return f'{low:.2f}' if low == high else f'{low:.2f} to {high:.2f}'


def render(data):
    text = r'''\subsection{Controlled dispatch-shift transfer}
The new campaign contains 36 complete suite executions and 20,580 check
executions. Six initial ExceptionGroup runs are VOID for cost analysis:
the profiler observed an ignored build-generated version module absent from
the frozen tracked-source inventory. Their raw records are retained. A
separate child protocol freezes that module before rerunning all six
predeclared schedules, without changing tests, seeds, layouts or endpoints.
The resulting admitted comparison has 30 executions and 19,968 checks over
five projects; it does not silently reclassify the original exclusions.
All admitted runs retain the original registry and status counts, including
attrs' environment-related failures.

\begin{table}[t]\centering\footnotesize
\caption{Primary cap32 padded-byte reduction (\%) under controlled dispatch
shifts relative to historical compact selection. Ranges span the three
fixed seeds; negative values are losses. No refitting.}
\label{tab:v12-shifts}
\begin{tabular}{@{}lrr@{}}\toprule
Project & File groups & Individual items\\\midrule
'''
    for name in PROJECTS:
        values = {r['policy']: r['gains']['historical'] for r in data['schedule'] if r['project'] == name}
        text += f"{NAMES[name]} & {range_tex(values['files'])} & {range_tex(values['items'])} \\\\\n"
    text += r'''\bottomrule\end{tabular}\end{table}

Against the historical selected comparator, file-group shuffling gives
three primary wins, nine ties and three losses; item shuffling gives zero
wins, nine ties and six losses. The comparison unit here is a scheduled
process, not an independent project. The small Jinja file-group gain survives,
whereas Click loses under both shifts. The three ties are projects whose
primary selection did not change. This directly limits the inference from
the repeated-pattern holdout. Every seed, all four frozen layouts, the
original compact comparison and secondary cap64 prices are retained in
the artifact. Neither the intervention nor the analytical witness identifies
natural deployment prevalence or a causal higher-order benefit.

\subsection{Service costs with byte observers disabled}
The separate ablation completes 240 arm executions: ten held-out traces,
three repeats and eight arms. All 10,080 raw-oracle/common-codec answer
checks agree; the two complete Packaging traces remain UNKNOWN under the
unchanged service budget. Table~\ref{tab:v12-observer} compares the same
primary layout to the maintained-counter ledger within each new timing block.

\begin{table}[t]\centering\footnotesize
\caption{Observer ablation. Disabled columns are mean case-median operation
times (ms); ratios compare HACT32 with counters in the same campaign.
Off=byte observers disabled (HACT32 ms / Counter ms at left);
on=original instrumentation in separate paired executions.}
\label{tab:v12-observer}
\begin{tabular}{@{}lrrrr@{}}\toprule
& \multicolumn{2}{c}{Observers off (ms)} & \multicolumn{2}{c}{HACT/counter}\\
Project & Counter & HACT32 & Off & On\\\midrule
'''
    for row in data['service']:
        off, on = row['states']['observer_disabled'], row['states']['instrumented']
        text += f"{NAMES[row['project']]} & {1000*off['counter']:.1f} & {1000*off['hact_selected']:.1f} & {off['ratio']:.2f} & {on['ratio']:.2f} \\\\\n"
    low, high = data['service_paired_ratio_ranges']['observer_disabled']
    text += r'''\bottomrule\end{tabular}\end{table}

Removing observational serialization reduces absolute service time but
does not reverse the comparison. Primary HACT is slower than counters
in every paired timing block under both instrumentation states. With
observers disabled, the project ratios of mean case medians range from
1.61 to 3.54; individual paired-block ratios range from
''' + f'{low:.3f} to {high:.3f}' + r'''. These are descriptive host-specific
ranges, not confidence intervals. The disabled variant retains functional
packet serialization, evidence digests, record copies, validation, caches
and codec round trips. It is a controlled prototype ablation, not an optimized
production implementation. The negative service result therefore survives
the identified observer-cost confound for this demand.
'''
    return text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    data = project()
    raw = json.dumps(data, indent=2, sort_keys=True) + '\n'
    latex = render(data)
    if args.check:
        if JSON.read_text() != raw or TEX.read_text() != latex:
            raise ValueError('manuscript projection drift')
        print('PASS: v12 manuscript projection')
    else:
        JSON.write_text(raw)
        TEX.write_text(latex)
        print('Wrote v12 manuscript numbers and tables.')


if __name__ == '__main__':
    main()
