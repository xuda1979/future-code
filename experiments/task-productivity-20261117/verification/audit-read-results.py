import json,hashlib,statistics,sys,copy,argparse
from pathlib import Path
parser=argparse.ArgumentParser(description='Independently authenticate and recompute task experiment evidence.')
parser.add_argument('report',type=Path);parser.add_argument('--repo',type=Path,default=Path.cwd());parser.add_argument('--baseline',type=Path);parser.add_argument('--output',type=Path);parser.add_argument('--input-map',type=Path,help='JSON map from original measured input paths to exact archived snapshots within the repo')
args=parser.parse_args();root=args.repo.resolve();baseline=(args.baseline or root.parent/'future-code-baseline').resolve()
path=args.report.resolve();report=json.loads(path.read_text());input_map=json.loads(args.input_map.read_text())if args.input_map else {}
assert set(input_map)<=set(report['inputHashes'])
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def audit(r,authenticate=True):
 assert r['modelCalls']==0 and r['modelTokens'] is None and r['dollars'] is None
 assert r['baseline']=='e2344798ea34cc3f06fed54679b44b084d94f512'
 assert r['sourceRevisions']['baseline']['head']==r['baseline']
 assert r['sourceRevisions']['baseline']['dirtyMeasuredPaths']==''
 if authenticate:
  for arm,directory in [('baseline',baseline),('candidate',root)]:
   for p,h in r['sourceHashes'][arm].items(): assert sha(directory/p)==h,(arm,p)
  for p,h in r['inputHashes'].items():
   selected=root/input_map.get(p,p)
   if p in input_map:selected.resolve().relative_to(root)
   assert sha(selected)==h,p
 rows=r['runs']; assert len(rows)==80
 assert len({(x['sample'],x['arm'],x['scenario']) for x in rows})==80
 for row in rows:
  assert row['verdict']=='PASS' and row['independentCheck']['verdict']=='PASS'
  expected_solved=row['scenario']not in ['failed-prerequisite','framework-failure','operator-cancel']
  assert row['taskSolved']==expected_solved
  assert row['outcome']==('REPAIR_PASSED'if expected_solved else 'GUARDRAIL_PASSED_NO_REPAIR')
  assert row['workerRounds']==len(row['rounds'])
  assert row['actualToolExecutions']==len(row['toolExecutions'])
  assert row['forcedRecoveryRounds']==sum(round['label']=='recover-useful-reads' for round in row['rounds'])
  assert row['mutationExecutions']==sum(x['kind']=='write' for x in row['toolExecutions'])
  cancelled=0
  for round in row['rounds']:
   calls=round['calls']; receipts=round['receipts'];assert len(calls)==len(receipts)
   assert {x['id'] for x in calls}=={x['tool_use_id'] for x in receipts}
   for c in calls:
    p=c['input'].get('path')
    rec=[x for x in receipts if x['tool_use_id']==c['id']];assert len(rec)==1
    if p in row['artifactBefore'] and rec[0].get('is_error') and 'Cancelled:' in rec[0].get('content',''):cancelled+=1
  assert cancelled==row['cancelledUsefulReads']
 for scenario,groups in r['summary'].items():
  subset=[x for x in rows if x['scenario']==scenario]
  assert len(subset)==10
  assert len({json.dumps(x['artifactAfter'],sort_keys=True) for x in subset})==1
  for arm,s in groups.items():
   selected=[x for x in subset if x['arm']==arm];assert len(selected)==5
   assert s['protocolPasses']==sum(x['verdict']=='PASS' for x in selected)
   assert s['completedRepairs']==sum(x['taskSolved'] for x in selected)
   assert s['guardrailPasses']==sum(x['outcome']=='GUARDRAIL_PASSED_NO_REPAIR' for x in selected)
   assert s['workerRounds']==[x['workerRounds'] for x in selected]
   for field in ['forcedRecoveryRounds','cancelledUsefulReads','actualToolExecutions']:assert s[field]==sum(x[field] for x in selected)
   assert s['medianWallMs']==statistics.median(x['wallMs'] for x in selected)
 return True
assert audit(report)
tampers=[]
for field in ['workerRounds','actualToolExecutions','forcedRecoveryRounds','mutationExecutions','cancelledUsefulReads']:
 corrupt=copy.deepcopy(report);corrupt['runs'][0][field]+=1
 try:audit(corrupt,False)
 except AssertionError:tampers.append(field)
 else:raise AssertionError('tamper was not detected: '+field)
result={'verdict':'PASS','experimentResult':report.get('result','NO_OVERALL_FIELD'),'auditScriptSha256':sha(Path(__file__)),'trials':len(report['runs']),'rawReportSha256':sha(path),'authenticatedSourceHashes':report['sourceHashes'],'authenticatedInputHashes':report['inputHashes'],'inputSnapshots':input_map,'tamperDetected':tampers,'totals':{arm:{'protocolPasses':sum(x['verdict']=='PASS' for x in report['runs'] if x['arm']==arm),'completedRepairs':sum(x['taskSolved'] for x in report['runs'] if x['arm']==arm),'workerRounds':sum(x['workerRounds'] for x in report['runs'] if x['arm']==arm),'forcedRecoveryRounds':sum(x['forcedRecoveryRounds'] for x in report['runs'] if x['arm']==arm)}for arm in ['baseline','candidate']}}
out=args.output or Path(__file__).parent/(path.stem+'-independent-audit.json');out.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
