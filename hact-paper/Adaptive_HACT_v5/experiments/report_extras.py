from pathlib import Path
import json,statistics,xml.etree.ElementTree as ET
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from experiments.runner import ROOT
from experiments.summarize import GEN,table,write,fmt,LABEL,PROJECTS

def main():
    overheads=json.loads((ROOT/'results/overheads.json').read_text());wrappers=json.loads((ROOT/'results/wrapper_smoke.json').read_text())
    width8=[r for r in overheads if r['width']==8];fit=[r['fit_seconds'] for r in width8];kernel=[r['synthetic_all_pass_kernel_median_seconds'] for r in width8]
    extras=[x[k]['complete_wrapper_seconds']-x[k]['pytest_process_seconds'] for x in wrappers for k in ['baseline','rejected','restored']]
    write('overhead_results.tex',f"The pooled compiler takes {min(fit):.3f}--{max(fit):.3f} seconds per project in the width-eight sensitivity run. A synthetic complete-pass kernel-only run with the same registries and five repetitions has a median of {min(kernel)*1000:.1f}--{max(kernel)*1000:.1f} ms; this measures the Python protocol, not project tests. The real-project wrapper smoke adds {min(extras):.3f}--{max(extras):.3f} seconds beyond its pytest process for copying, identities, contract checks and certificates. These integrity costs are material relative to the small observed ordering-time differences. We do not claim that the wrapper makes bare pytest faster end to end.")
    rows=[]
    for width,label in [(1,'1'),(8,'8'),(32,'32'),(None,'End only')]:
        rec=[r for r in overheads if (r['width'] not in [1,8,32] if width is None else r['width']==width)]
        cases=[x for r in rec for x in r['costs']];a=statistics.mean(x['fixed'] for x in cases);b=statistics.mean(x['fitted'] for x in cases)
        rows.append([label,len(cases),fmt(a/1024,1),fmt(b/1024,1),fmt(100*(1-b/a))])
    write('batching_table.tex',table('Exploratory batching sensitivity on the same 33 confirmation cases. Each row refits on training waves only. Values are computed from the exact packet-price formula; batching changes progress granularity and is not a free speedup.','lrrrr','Completions/wave & Cases & Fixed KiB & Fitted KiB & Reduction (\\%)',rows,'tab:batching'))
    rows=[]
    for r in wrappers:
        for key,name in [('baseline','Baseline'),('rejected','Known fault'),('restored','Restoration')]:
            v=r[key];rows.append([LABEL[r['project']],name,v['executed'],v['verdict'],fmt(v['pytest_process_seconds'],3),fmt(v['complete_wrapper_seconds'],3)])
    write('wrapper_table.tex',table('Functional wrapper smoke with actual project tests. One known rejected confirmation mutant per project is selected for demonstration, then the original source is restored. These are single runs, not a sampled timing benchmark or autonomous repairs.','llrlrr','Subject & Stage & Tests & Verdict & Process s & Wrapper s',rows,'tab:wrapper'))
    xml=ET.parse(ROOT/'results/final_tests.xml').getroot();suite=xml if xml.tag=='testsuite' else xml.find('testsuite')
    n=int(suite.get('tests'));fail=int(suite.get('failures'))+int(suite.get('errors'));assert fail==0
    write('diagnostics.tex',f"The final development-tree validation suite passes all {n} tests. It includes the original 90 HACT tests plus 54 tests for frontiers, ordering, epochs, conflicting results, identities and the strict wrapper. A separate original-runtime run passes 263 tests. The latter is not added to the 456 scoped baseline tests as though they were all distinct. The independent stored-evidence audit verifies 121 nonoverlapping source interventions, 300 certificate decisions, 384 actual timing-run verdicts, and 17 paired statistical comparisons, including recomputation of the confidence intervals. A deliberately changed packet total is rejected by that independent path.\n\nThe original capture attempt for the full Future Code suite produced an incomplete result and is retained as a diagnostic, not a successful baseline. A later complete run with file-backed subprocess output passed all 263 tests. The mutation campaign uses the explicitly documented 138-test core scope. Incomplete executions are never filled with fabricated outcomes.\n\nThe generic wrapper also rejects modified protected acceptance inputs on all three demonstrated projects. The unit tests cover a malformed order that tries to omit a test and a candidate that writes into its checked source snapshot; neither receives a pass. These are tested local boundaries, not proof against a hostile process with access to the checker or the host.")
    summary=json.loads((ROOT/'results/summary_metrics.json').read_text())['comparisons'];episodes=json.loads((ROOT/'results/frozen_evaluation.json').read_text())['episodes']
    check=[];timing=[]
    for project in PROJECTS:
        bad=[r for r in episodes if r['phase']=='confirmation' and r['project']==project and r['oracle_fail']]
        check.append(100*(1-sum(r['scheduling']['conditional']['tests'] for r in bad)/sum(r['scheduling']['coverage']['tests'] for r in bad)))
        cases=[r for r in summary['confirmation_time_coverage']['cases'] if r['project']==project]
        timing.append(100*(1-sum(r['candidate'] for r in cases)/sum(r['baseline'] for r in cases)))
    fig,ax=plt.subplots(figsize=(6.7,3.0));x=list(range(3));w=.35
    ax.bar([v-w/2 for v in x],check,w,label='Checks to failure (replay, rejected cases)')
    ax.bar([v+w/2 for v in x],timing,w,label='Actual process time (timing cohort)')
    ax.axhline(0,linewidth=.8);ax.set_xticks(x,[LABEL[x] for x in PROJECTS]);ax.set_ylabel('Reduction vs call-profile baseline (%)')
    ax.legend(frameon=False,fontsize=8);ax.grid(axis='y',alpha=.2);fig.tight_layout()
    fig.savefig(GEN/'feedback_tradeoff.pdf');plt.close(fig)
    print('Extras and figure generated',n,flush=True)
if __name__=='__main__':main()
