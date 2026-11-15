#!/usr/bin/env python3
"""Before-model calibration of the actual frozen fixture/checker interface."""
import collections
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('controller',HERE/'harness.py')
h=importlib.util.module_from_spec(spec); spec.loader.exec_module(h)
order=json.loads((h.LAB/'order.json').read_text()); seen=set(); results=[]
for ident in order:
    root,state=h.load_trial(ident)
    if state['kind'] in seen: continue
    seen.add(state['kind'])
    with tempfile.TemporaryDirectory(prefix='fc-canary-calibration-') as tmp:
        dest=Path(tmp); workspace=dest/'workspace'; shutil.copytree(state['workspace'],workspace)
        meta=json.loads((root/'meta.json').read_text())
        if state['kind']=='push_clean':
            remote=dest/'remote.git'; h.git(workspace,'init','--bare','-q',str(remote))
            h.git(workspace,'remote','set-url','origin',str(remote)); meta['remote_path']=str(remote)
        h.save(dest/'meta.json',meta)
        clone={**state,'workspace':str(workspace),'answer':None}
        bad=h.check(dest,clone)
        assert bad['code']==1,(state['kind'],bad)
        if state['kind']=='push_clean':
            assert h.run(['git','push','origin','HEAD:refs/heads/result'],workspace)['code']==0
        elif state['kind'] in ('extension_seeded','recovery_seeded'):
            config=json.loads((workspace/'config.json').read_text()); config['engine']='python'
            if state['kind']=='extension_seeded': config['task_file']='data/train-v2.json'
            h.save(workspace/'config.json',config)
        else:
            records=[json.loads(p.read_text()) for p in sorted((workspace/'logs').glob('*.json'))]
            totals=collections.Counter()
            for r in records: totals[r['stage']]+=r['duration_ms']
            clone['answer']={'runs':len(records),'total_ms':sum(r['duration_ms'] for r in records),
                'failed_runs':sum(r['status']=='failed' for r in records),'dominant_stage':max(totals,key=totals.get)}
        good=h.check(dest,clone)
        assert good['code']==0,(state['kind'],good)
        results.append({'kind':state['kind'],'bad_exit':bad['code'],'good_exit':good['code'],
                        'bad_output':bad['stdout'],'good_output':good['stdout']})
h.save(HERE/'fixture-calibration.json',{'status':'PASS','controls':results,'provider_calls':0})
print(json.dumps({'status':'PASS','kinds':len(results),'controls':2*len(results)}))
