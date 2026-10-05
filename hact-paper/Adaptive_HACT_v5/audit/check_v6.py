"""Independent arithmetic/data audit for the frozen HACT v6 journal extension."""
from __future__ import annotations
from copy import deepcopy
from pathlib import Path
import hashlib,json,math,statistics
import numpy as np
from experiments_v3.bench import draw
ROOT=Path(__file__).resolve().parents[1]
CONTRACT=json.loads((ROOT/"docs/V6_JOURNAL_EXPERIMENT_CONTRACT.json").read_text())
RAW=json.loads((ROOT/"results/v6/journal_extension.json").read_text())
SUMMARY=json.loads((ROOT/"results/v6/summary.json").read_text())
HEADER=512;CARD=320
def canonical_hash(value): return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(",",":")).encode()).hexdigest()
def compact_coverage(order,fanout):
    layer=[1<<int(i) for i in order]; nodes=[]
    while len(layer)>1:
        parents=[]
        for o in range(0,len(layer),fanout):
            group=layer[o:o+fanout]
            if len(group)==1: parents.append(group[0]); continue
            mask=0
            for m in group: mask|=m
            nodes.append((mask,HEADER+CARD*len(group)));parents.append(mask)
        layer=parents
    return nodes
def independent_cost(order,episodes,fanout):
    cov=compact_coverage(order,fanout); total=sum(p for _,p in cov)
    for ep in episodes:
        for wave in ep:
            wm=0
            for i in set(wave): wm|=1<<int(i)
            total+=sum(p for m,p in cov if m&wm)
    return int(total)
def verify_normal(r):
    cfg=CONTRACT["normal"];n=r["n"];rng=np.random.default_rng(r["seed"]);latent=tuple(map(int,rng.permutation(n)))
    train=draw(rng,n,cfg["train_epochs"],r["kind"],latent);valid=draw(rng,n,cfg["validation_epochs"],r["kind"],latent);test=draw(rng,n,cfg["heldout_epochs"],r["kind"],latent)
    assert r["data_sha256"]=={"training":canonical_hash(train),"validation":canonical_hash(valid),"heldout":canonical_hash(test)}
    orders={"incumbent":tuple(range(n)),**{k:tuple(v) for k,v in r["orders"].items()}}
    for name,order in orders.items():
        assert r["validation_totals"][name]==independent_cost(order,valid,cfg["fanout"])
        assert r["heldout_totals"][name]==independent_cost(order,test,cfg["fanout"])
    exp="learned" if r["validation_totals"]["learned"]<r["validation_totals"]["incumbent"] else "incumbent";assert r["selected"]==exp
    base=r["heldout_totals"]["incumbent"];red=100*(1-r["heldout_totals"][exp]/base);assert abs(red-r["metrics"]["practical_reduction"])<1e-12
def verify_shift(r):
    cfg=CONTRACT["shift"];n=r["n"];ra=np.random.default_rng(r["seed"]);la=tuple(map(int,ra.permutation(n)));ta=draw(ra,n,cfg["train_epochs_A"],cfg["family"],la);va=draw(ra,n,cfg["validation_epochs_A"],cfg["family"],la)
    rb=np.random.default_rng(r["seed"]+cfg["second_regime_seed_offset"]);lb=tuple(map(int,rb.permutation(n)));tb=draw(rb,n,cfg["train_epochs_B"],cfg["family"],lb);vb=draw(rb,n,cfg["validation_epochs_B"],cfg["family"],lb);test=draw(rb,n,cfg["heldout_epochs_B"],cfg["family"],lb)
    assert r["data_sha256"]=={"trainA":canonical_hash(ta),"validA":canonical_hash(va),"trainB":canonical_hash(tb),"validB":canonical_hash(vb),"testB":canonical_hash(test)}
    orders={"incumbent":tuple(range(n)),**{k:tuple(v) for k,v in r["orders"].items()}}
    for name in ("incumbent","learnedA","learnedB","oracleB"): assert r["heldout_B"][name]==independent_cost(orders[name],test,cfg["fanout"])
def run(raw):
    assert raw["experiment_id"]==CONTRACT["experiment_id"] and raw["contract_sha256"]==canonical_hash(CONTRACT)
    assert len(raw["normal"])==180 and len(raw["shift"])==60
    for r in raw["normal"]: verify_normal(r)
    for r in raw["shift"]: verify_shift(r)
    assert SUMMARY["normal_workloads"]==180 and SUMMARY["shift_workloads"]==60
    return {"normal":180,"shift":60,"contract_sha256":canonical_hash(CONTRACT),"status":"PASS"}
result=run(RAW);t=deepcopy(RAW);t["normal"][0]["heldout_totals"]["incumbent"]+=1
try: run(t)
except AssertionError: result["tamper_detection"]="PASS"
else: raise AssertionError("tamper not detected")
print(json.dumps(result,indent=2))
