"""Correct summary medians from immutable records; never change task outcomes."""
import argparse,copy,hashlib,json,statistics
from pathlib import Path
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('raw',type=Path);parser.add_argument('output',type=Path)
args=parser.parse_args();raw_bytes=args.raw.read_bytes();original=json.loads(raw_bytes);corrected=copy.deepcopy(original)
changes=[]
for scenario,groups in corrected['summary'].items():
 for arm,summary in groups.items():
  rows=[row for row in original['runs']if row['scenario']==scenario and row['arm']==arm]
  done=[row for row in rows if row['verdict']=='PASS']
  for key,values in [('medianCompletionWallMs',[row['completionWallMs']for row in done]),('medianObservationWallMs',[row['observationWallMs']for row in rows])]:
   standard=statistics.median(values)if values else None
   if summary[key]!=standard:changes.append({'scenario':scenario,'arm':arm,'field':key,'reported':summary[key],'corrected':standard,'n':len(values)})
   summary[key]=standard
assert corrected['runs']==original['runs']
assert corrected['result']==original['result'] and corrected['gateFailures']==original['gateFailures']
canonical=lambda value:json.dumps(value,sort_keys=True,separators=(',',':')).encode()
corrected['summaryCorrection']={'kind':'STANDARD_MEDIAN_ONLY_NO_NEW_TASK_COHORT','rawReportPath':args.raw.as_posix(),'rawReportSha256':hashlib.sha256(raw_bytes).hexdigest(),'immutableRowsSha256':hashlib.sha256(canonical(original['runs'])).hexdigest(),'replayScriptSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'correctedFields':changes,'taskOutcomesChanged':False}
args.output.write_text(json.dumps(corrected,indent=2)+'\n')
print(json.dumps({'result':corrected['result'],'correction':corrected['summaryCorrection']}))
