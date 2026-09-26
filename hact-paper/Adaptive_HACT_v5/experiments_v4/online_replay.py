"""New runtime API reproduces the ORIGINAL v3 priced-window path. No new streams."""
import json,time
from pathlib import Path
from ichact.window import PricedWindow
ROOT=Path(__file__).resolve().parents[1]

def main():
    rows=[]
    for p in sorted((ROOT/'results/v3/online').glob('*.json')):
        d=json.loads(p.read_text());policy=PricedWindow(d['migration'],initial=d['frozen_index'])
        actions=[];t=time.perf_counter()
        for i,c in enumerate(d['costs']):
            actions.append(policy.choose());policy.observe(c)
            if i%257==0:policy=PricedWindow.resume(policy.state())
        elapsed=time.perf_counter()-t
        expected=d['summary']['methods']['window_priced']
        assert actions==d['actions']['window_priced']
        assert policy.service==expected['service_bytes'] and policy.switch_cost==expected['switch_bytes']
        rows.append({'source':p.name,'events':policy.round,'service_bytes':policy.service,'switch_bytes':policy.switch_cost,
                     'actions_match':True,'checkpoint_roundtrip':True,'controller_seconds':elapsed})
    (ROOT/'results/v4/online_replay.json').write_text(json.dumps(rows,indent=2));print(len(rows),'archived streams matched')
if __name__=='__main__':main()
