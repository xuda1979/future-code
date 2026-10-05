"""Regenerate the journal summary figure from frozen v6 summary statistics."""
from pathlib import Path
import json
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT=Path(__file__).resolve().parents[1]
summary=json.loads((ROOT/"results/v6/summary.json").read_text())
out=ROOT/"paper/figures/v6_journal_extension.pdf"
normal={(x["n"],x["kind"]):x for x in summary["normal"]}
shift={x["n"]:x for x in summary["shift"]}
ns=[128,512,1024]
fig,axes=plt.subplots(1,2,figsize=(9.2,3.6))
ax=axes[0]
for key,label in [
    ("practical_reduction","validated learned"),
    ("marginal_reduction","marginal-only"),
    ("random_reduction","validated random"),
    ("oracle_reduction","latent reference"),
]:
    means=[normal[(n,"cluster")]["methods"][key]["mean"] for n in ns]
    lo=[normal[(n,"cluster")]["methods"][key]["ci95_mean"][0] for n in ns]
    hi=[normal[(n,"cluster")]["methods"][key]["ci95_mean"][1] for n in ns]
    yerr=np.vstack((np.asarray(means)-np.asarray(lo),np.asarray(hi)-np.asarray(means)))
    ax.errorbar(range(3),means,yerr=yerr,marker="o",capsize=3,label=label)
ax.axhline(0,linewidth=.8)
ax.set_xticks(range(3),[str(n) for n in ns])
ax.set_xlabel("registry size")
ax.set_ylabel("held-out reduction vs fixed8 (%)")
ax.set_title("Disjoint-seed replication: clustered waves")
ax.legend(fontsize=8)

ax=axes[1]
for key,label in [
    ("stale_reduction","stale layout"),
    ("retuned_reduction","retuned"),
    ("oracle_reduction","latent reference"),
]:
    means=[shift[n]["methods"][key]["mean"] for n in ns]
    lo=[shift[n]["methods"][key]["ci95_mean"][0] for n in ns]
    hi=[shift[n]["methods"][key]["ci95_mean"][1] for n in ns]
    yerr=np.vstack((np.asarray(means)-np.asarray(lo),np.asarray(hi)-np.asarray(means)))
    ax.errorbar(range(3),means,yerr=yerr,marker="o",capsize=3,label=label)
ax.axhline(0,linewidth=.8)
ax.set_xticks(range(3),[str(n) for n in ns])
ax.set_xlabel("registry size")
ax.set_ylabel("held-out reduction vs fixed8 (%)")
ax.set_title("Distribution shift and retuning")
ax.legend(fontsize=8)
fig.tight_layout()
out.parent.mkdir(parents=True,exist_ok=True)
fig.savefig(out,bbox_inches="tight")
