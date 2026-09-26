"""Quantitative plots from released JSON, never fabricated diagram values."""
from pathlib import Path
import json
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'paper/figures';OUT.mkdir(exist_ok=True)
s=json.loads((ROOT/'results/v3/statistics.json').read_text())
fig,ax=plt.subplots(figsize=(7.0,3.2))
names=['cluster','independent','singleton','global'];values=[s['ordering'][n]['original']['mean'] for n in names]
err=np.array([[s['ordering'][n]['original']['mean']-s['ordering'][n]['original']['low'] for n in names],
              [s['ordering'][n]['original']['high']-s['ordering'][n]['original']['mean'] for n in names]])
ax.bar(names,values,yerr=err,capsize=4);ax.axhline(0,linewidth=.8,color='black')
ax.set_ylabel('Reduction vs original-order DP (%)');ax.set_ylim(-3,32);ax.set_xlabel('Workload family (20 paired seeds each)')
fig.tight_layout();fig.savefig(OUT/'ordering.pdf');plt.close(fig)
fig,ax=plt.subplots(figsize=(7.0,3.2));modes=['stationary','long_shift','rapid_shift','global'];x=np.arange(4);w=.23
for j,(key,label) in enumerate([('coupled_share','Coupled fixed-share'),('independent_share','Independent sampling'),('window_priced','Priced window heuristic')]):
 ax.bar(x+(j-1)*w,[s['online'][m][key]['mean'] for m in modes],width=w,label=label)
ax.axhline(1,linewidth=.8,color='black',linestyle='--');ax.set_xticks(x,['Stationary','Long shift','Rapid shift','Global'])
ax.set_ylabel('Total bytes / frozen layout');ax.set_ylim(0,2.5);ax.legend(frameon=False,fontsize=8,ncol=3)
fig.tight_layout();fig.savefig(OUT/'online.pdf');plt.close(fig)
