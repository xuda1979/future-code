import json,hashlib,statistics,sys,copy,argparse
from pathlib import Path
parser=argparse.ArgumentParser(description='Independently authenticate and recompute task experiment evidence.')
parser.add_argument('report',type=Path);parser.add_argument('--repo',type=Path,default=Path.cwd());parser.add_argument('--baseline',type=Path);parser.add_argument('--output',type=Path);parser.add_argument('--input-map',type=Path,help='JSON map from original measured input paths to exact archived snapshots within the repo')
args=parser.parse_args();root=args.repo.resolve();baseline=(args.baseline or root.parent/'future-code-baseline').resolve()
path=args.report.resolve();report=json.loads(path.read_text());input_map=json.loads(args.input_map.read_text())if args.input_map else {}
assert set(input_map)<=set(report['inputHashes'])
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def med(v):return statistics.median(v)if v else None
def audit(r,authenticate=True):
 assert r['modelCalls']==0 and r['modelTokens'] is None and r['dollars'] is None
 assert r['sourceRevisions']['baseline']['head']=='e2344798ea34cc3f06fed54679b44b084d94f512'
 assert r['sourceRevisions']['baseline']['dirtyMeasuredPaths']==''
 if authenticate:
  for arm,directory in [('baseline',baseline),('candidate',root)]:
   for p,h in r['sourceHashes'][arm].items():assert (sha(directory/p)if(directory/p).exists()else None)==h,(arm,p)
  for p,h in r['inputHashes'].items():
   selected=root/input_map.get(p,p)
   if p in input_map:selected.resolve().relative_to(root)
   assert sha(selected)==h,p
 rows=r['runs'];assert len(rows)==50
 unexpected=[x for x in rows if x['verdict']!=('CENSORED'if x['arm']=='baseline'and x['scenario']=='counter-stalled'else 'PASS')]
 assert r['result']==('FAIL'if unexpected else 'PASS')
 assert len(r['gateFailures'])>=len(unexpected)
 assert len({(x['sample'],x['arm'],x['scenario'])for x in rows})==50
 for row in rows:
  assert row['observationLimitMs']==2500
  assert row['counterRequests']==len(row['responseCounts'])
  expected=0 if row['scenario']=='counter-local-json' and row['arm']=='candidate' else 1
  assert row['counterRequests']==expected
  assert row['clientInitializations']==expected
  if expected:assert row['responseCounts'][0]['contentSha256']==row['artifactBefore']
  if row['verdict']=='CENSORED':
   assert row['completionWallMs'] is None and row['independentCheck'] is None
   assert row['taskSolved'] is False
   if row.get('lateCompletionWallMs') is not None:
    assert row['lateCompletionWallMs']>2500
    assert row['lateIndependentCheck']['verdict']=='PASS'
    assert row['outcome']=='LATE_COMPLETION_OUTSIDE_WINDOW'
   else:
    assert row['arm']=='baseline' and row['scenario']=='counter-stalled'
    assert row['outcome']=='CENSORED'
    assert row['mutations']==0 and row['artifactAfter']==row['artifactBefore']
    assert row['fullReadGuard']=='PENDING' and row['rangeReads']==0
    assert row['closedByProductionBeforeCleanup']==0
  else:
   assert row['verdict']=='PASS' and row['independentCheck']['verdict']=='PASS'
   assert row['completionWallMs']<=2500
   if row['scenario']=='counter-oversize':
    assert row['taskSolved']is False and row['mutations']==0
    assert row['outcome']=='OVERSIZE_GUARD_PASSED_NO_REPAIR'
    assert row['fullReadGuard']=='REJECTED_REQUIRES_RANGE' and row['rangeReads']==0
    assert row['artifactAfter']==row['artifactBefore']
   else:
    assert row['taskSolved']is True and row['mutations']==1 and row['outcome']=='REPAIR_PASSED'
    assert row['artifactAfter']!=row['artifactBefore']
   if row['scenario']=='counter-stalled':
    assert row['rangeReads']==7 and row['closedByProductionBeforeCleanup']==1
    assert row['fullReadGuard']=='REJECTED_REQUIRES_RANGE'
   if row['scenario']=='counter-unavailable' and row['arm']=='candidate':
    assert row['rangeReads']==7 and row['fullReadGuard']=='REJECTED_REQUIRES_RANGE'
 for scenario,groups in r['summary'].items():
  subset=[x for x in rows if x['scenario']==scenario];assert len(subset)==10
  if scenario!='counter-stalled':assert len({x['artifactAfter']for x in subset})==1
  for arm,s in groups.items():
   selected=[x for x in subset if x['arm']==arm];assert len(selected)==5
   finished=[x for x in selected if x['verdict']=='PASS']
   assert s['protocolPasses']==len(finished)
   assert s['completedRepairs']==sum(x['taskSolved']for x in selected)
   assert s['guardrailPasses']==sum(x['outcome']=='OVERSIZE_GUARD_PASSED_NO_REPAIR'for x in selected)
   assert s['censored']==len(selected)-len(finished)
   for f in ['counterRequests','rangeReads']:assert s[f]==sum(x[f]for x in selected)
   assert s['medianCompletionWallMs']==med([x['completionWallMs']for x in finished])
   assert s['medianObservationWallMs']==med([x['observationWallMs']for x in selected])
 return True
assert audit(report)
tampers=[]
for f in ['counterRequests','rangeReads','mutations','closedByProductionBeforeCleanup']:
 corrupt=copy.deepcopy(report);corrupt['runs'][0][f]+=1
 try:audit(corrupt,False)
 except AssertionError:tampers.append(f)
 else:raise AssertionError('tamper not detected: '+f)
corrupt=copy.deepcopy(report);oversize=next(x for x in corrupt['runs']if x['scenario']=='counter-oversize');oversize['taskSolved']=True
try:audit(corrupt,False)
except AssertionError:tampers.append('oversize-labelled-repair')
else:raise AssertionError('oversize falsely accepted')
result={'verdict':'PASS','experimentResult':report.get('result','NO_OVERALL_FIELD'),'auditScriptSha256':sha(Path(__file__)),'trials':len(report['runs']),'rawReportSha256':sha(path),'authenticatedSourceHashes':report['sourceHashes'],'authenticatedInputHashes':report['inputHashes'],'inputSnapshots':input_map,'tamperDetected':tampers,'totals':{arm:{'protocolPasses':sum(x['verdict']=='PASS'for x in report['runs']if x['arm']==arm),'completedRepairs':sum(x['taskSolved']for x in report['runs']if x['arm']==arm),'guardrailPasses':sum(x['outcome']=='OVERSIZE_GUARD_PASSED_NO_REPAIR'for x in report['runs']if x['arm']==arm),'censored':sum(x['verdict']=='CENSORED'for x in report['runs']if x['arm']==arm)}for arm in ['baseline','candidate']}}
out=args.output or Path(__file__).parent/(path.stem+'-independent-audit.json');out.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
