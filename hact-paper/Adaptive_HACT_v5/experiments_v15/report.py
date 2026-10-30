"""Project post-review observations into explicitly separated manuscript tables."""
from collections import Counter
from fractions import Fraction
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROJECTS = ('click', 'jinja', 'pluggy', 'attrs', 'exceptiongroup')
NAMES = dict(zip(PROJECTS, ('Click', 'Jinja', 'Pluggy', 'attrs', 'ExceptionGroup')))
CATEGORIES = ('hashing', 'json', 'compression', 'kernel_capsules', 'tree', 'other')


def read(name):
    return json.loads((ROOT / name).read_text())


def project():
    dispatch = read('results/v15/cap64_dispatch.json')['rows']
    cpu = read('results/v15/cpu_profile.json')['rows']
    sparse = read('results/v15/sparse_packaging.json')
    if len(dispatch) != 30 or len(cpu) != 20 or sparse['status'] not in ('PASS', 'UNKNOWN'):
        raise ValueError('incomplete review follow-up evidence')
    outcomes, detailed = {}, []
    for policy in ('files', 'items'):
        rows = [r for r in dispatch if r['policy'] == policy]
        outcomes[policy] = {base: dict(Counter('win' if r['costs']['cap64'] < r['costs'][base]
                  else 'loss' if r['costs']['cap64'] > r['costs'][base] else 'tie' for r in rows))
                  for base in ('historical', 'exchangeable')}
        for name in PROJECTS:
            group = sorted((r for r in rows if r['project'] == name), key=lambda r: r['seed'])
            if [r['seed'] for r in group] != [2026102101, 2026102102, 2026102103]:
                raise ValueError('missing review comparison seed')
            detailed.append({'project': name, 'policy': policy, 'gains_percent': {
                base: [str(Fraction(100 * (r['costs'][base] - r['costs']['cap64']), r['costs'][base]))
                       for r in group] for base in ('historical', 'exchangeable')}})
    profiles = []
    for name in PROJECTS:
        for arm in ('counter', 'hact_selected'):
            rows = [r for r in cpu if r['project'] == name and r['arm'] == arm]
            if len(rows) != 2:
                raise ValueError('two complete retained cases required per profile arm')
            total = sum(r['exclusive_total_seconds'] for r in rows)
            shares = {k: 100 * sum(r['exclusive_seconds_by_category'][k] for r in rows) / total for k in CATEGORIES}
            if abs(sum(shares.values()) - 100) > 1e-8:
                raise ValueError('exclusive profile shares do not sum to 100')
            profiles.append({'project': name, 'arm': arm, 'exclusive_seconds': total, 'percent': shares})
    if sparse['status'] == 'PASS':
        sparse = {k: v for k, v in sparse.items() if k != 'selected_order'}
        sparse['heldout_gain_percent'] = str(Fraction(
            100 * sum(r['original_padded_bytes'] - r['selected_padded_bytes'] for r in sparse['holdouts']),
            sum(r['original_padded_bytes'] for r in sparse['holdouts'])))
    files = ['results/v15/' + p for p in ('FREEZE.json', 'cap64_dispatch.json', 'cpu_profile.json', 'sparse_packaging.json', 'POST_RUN_CONTEXT.json')]
    return {'schema': 'hact-v15-manuscript-1', 'cap64_outcomes': outcomes, 'cap64_detail': detailed,
            'profiles': profiles, 'sparse': sparse,
            'inputs': {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in files}}


def span(values):
    values = [float(Fraction(x)) for x in values]
    return f'{min(values):.2f}' if min(values) == max(values) else f'{min(values):.2f} to {max(values):.2f}'


def render_main(data):
    s = data['sparse']
    text = r'''\subsection{Post-review resource and diagnostic follow-ups}
The frozen cap64 layouts, rescored on the same 30 admitted dispatch traces,
win 12 file-group cases and tie three against the historical compact
comparator; under item shuffling they lose 12 and tie three.
Against the symmetric baseline, cap64 wins all 15 file-group cases and
loses all 15 item-shuffled cases. Thus its larger local search budget
improves the grouped-completion regime without removing the transfer
boundary. The supplement reports every project's three-seed ranges.

'''
    if s['status'] == 'PASS':
        text += (r'A new sparse compact compiler admits the complete Packaging registry: '
                 + f"{s['n']:,} checks, {s['fit']['positive_edges']:,} positive pairs, "
                 + f"{s['process_peak_rss_bytes']/1024**2:.1f} MiB peak process RSS under a 2 GiB address-space limit. "
                 + f"Fit plus validation takes {s['fit_validation_seconds']:.2f} seconds after input loading. "
                 + r'Training uses runs 0--1 and validation run 2; the selected compact layout costs '
                 + f"{s['holdouts'][0]['selected_padded_bytes']:,} rather than {s['holdouts'][0]['original_padded_bytes']:,} "
                 + f"padded bytes on each retained holdout ({float(Fraction(s['heldout_gain_percent'])):.2f}\\% less). "
                 + r'This is a post-review replay on repeated completion patterns, not a new suite execution, '
                 + r'cap64 fit or large-registry service trial. Historical Packaging exclusions remain unchanged.' + '\n\n')
    else:
        text += r'The budgeted sparse Packaging follow-up remains $\UNKNOWN$; its resource failure is retained.' + '\n\n'
    text += r'''Exclusive process-CPU profiles on the ten admitted cases locate tree
functions at 9.0--58.4\%, JSON work at 15.4--35.2\%, and hashing at
0.9--1.9\% of HACT's profiled operation CPU. All 840 paired-arm answer
checks agree. These cProfile diagnostics exclude input/oracle work and
retain the original unprofiled Table~\ref{tab:v12-observer} estimand.
Allocation is not separately isolated; the supplement gives disjoint
categories, counter profiles and the dominant functions.
'''
    return text


def render_supplement(data):
    text = r'''\section{Post-review compiler, transfer and CPU diagnostics}
These follow-ups use the internally frozen protocol
\path{docs/V15_REVIEW_PROTOCOL.md}; this is not external preregistration.
The freeze binds source and all reused inputs before the new compiler/profile
executions. Frozen historical observations and endpoints are unchanged.

\subsection{Secondary cap64 transfer}
Table~\ref{tab:s-cap64} gives savings of cap64 relative to each named
comparator: positive values mean fewer padded bytes. Each range spans three
fixed dispatch seeds. The unit remains a scheduled process on the original
five admitted projects, with no new checker execution or refitting.
\begin{table}[htbp]\centering\small
\caption{Frozen cap64 padded-byte savings (\%) on all admitted dispatch traces.}
\label{tab:s-cap64}
\begin{tabular}{@{}llrr@{}}\toprule
Project & Policy & vs. historical compact & vs. symmetric\\\midrule
'''
    for r in data['cap64_detail']:
        text += f"{NAMES[r['project']]} & {r['policy']} & {span(r['gains_percent']['historical'])} & {span(r['gains_percent']['exchangeable'])} \\\\\n"
    text += r'''\bottomrule\end{tabular}\end{table}

\subsection{Sparse compact ordering and its resource boundary}
The prototype accumulates exact positive pair intersections and singleton
counts from bounded-width training waves. It sorts positive Jaccard edges,
constructs a maximum-spanning forest, and linearizes each component by
deterministic depth-first traversal; zero-affinity components retain canonical
ties. This is an established spanning-forest heuristic, not a sparse
implementation of average linkage and not an optimizer of the tree objective.
For $W$ waves of width at most $w$, at most $W\binom w2$ positive-pair
updates are needed and at most $E\le W\binom w2$ distinct edges are stored.
Counting and ordering take $O(Ww^2+E\log E+n)$ arithmetic operations and
$O(n+E)$ storage apart from integer bit complexity. The compact tree's
separate ancestor-scoring index uses $O(n\,\mathrm{height})$ references.
An explicit edge limit fails closed rather than dropping observations.

Only original and sparse compact layouts enter this new validation catalogue.
Cold construction and touched ancestors are fully charged, with incumbent
retention on ties. The complete Packaging replay fits runs 0--1, selects on
run 2, then scores runs 3--4. Its two identical held-out completion patterns
establish repeatability, not natural transfer. The 2 GiB limit applies to the
whole child process, and the peak RSS includes loading, fitting, validation
and held-out scoring. The reported fit/validation seconds exclude file loading
and hash verification. An independent literal tree traversal verifies every
reported held-out price. This experiment neither changes the earlier dense
compiler exclusion nor admits Packaging into the 2,048-check service study.

\subsection{Exclusive CPU accounting}
\begin{table}[htbp]\centering\scriptsize
\caption{Pooled exclusive process-CPU shares (\%) for two retained cases per
project and arm. cProfile uses \texttt{time.process\_time}; categories are
disjoint and sum to 100 before rounding. H=HACT32; C=counter ledger.}
\label{tab:s-profile}
\begin{tabular}{@{}llrrrrrr@{}}\toprule
Project & Arm & Hash & JSON & zlib & Kernel & Tree & Other\\\midrule
'''
    for r in data['profiles']:
        label = 'H' if r['arm'] == 'hact_selected' else 'C'
        text += f"{NAMES[r['project']]} & {label} & " + ' & '.join(f"{r['percent'][k]:.1f}" for k in CATEGORIES) + r' \\' + '\n'
    text += r'''\bottomrule\end{tabular}\end{table}
Input snapshots and the semantic/wire oracle are outside profiling. Every
case replays build, every eight-completion ingest and the same cold/warm query
sequence as the observer-disabled experiment. Hashing contains the digest
wrapper and hash primitives; JSON contains encoding, decoding and canonical
serialization wrappers; zlib contains compression/decompression; kernel and
tree contain their remaining module-local functions. Thus nested serialization
is charged to JSON, not also to a caller's cumulative time. Other includes
orchestration, generic builtins and answer processing. Allocation is distributed
across functions and has not been isolated. In Click, the leading HACT
functions are \texttt{walk}, \texttt{to\_dict} and \texttt{validate\_tree};
the retained per-arm records list the twenty largest exclusive functions.
Profiler overhead changes the execution regime. These shares locate work;
they do not decompose the unprofiled HACT/counter elapsed-time difference or
establish the speedup obtainable by removing a category.
'''
    return text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    check = parser.parse_args().check
    data = project()
    outputs = {'results/v15/manuscript_numbers.json': json.dumps(data, indent=2, sort_keys=True) + '\n',
               'paper/v15_review_results.tex': render_main(data),
               'paper/v15_review_supplement.tex': render_supplement(data)}
    for name, text in outputs.items():
        path = ROOT / name
        if check:
            if path.read_text() != text:
                raise ValueError('review projection changed: ' + name)
        else:
            path.write_text(text)
    print(json.dumps({'status': 'PASS', 'mode': 'check' if check else 'write'}))


if __name__ == '__main__':
    main()
