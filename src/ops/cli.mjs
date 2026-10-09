import { remoteExec, fanout, snapshot, compactState, updateTask, queueDecision, resolveDecision, recordEvidence, verifyEvidence, supervise, superviseOnce } from './runtime.mjs';
import { readFileSync } from 'node:fs';
const usage = 'ops exec BOX COMMAND | fanout REQUESTS.json | task JSON | state | compact | decision JSON | answer ID TEXT | evidence JSON | verify ID | watch-once | supervise';
export async function handleOps(args, project = process.cwd(), signal = new AbortController().signal) {
  const [verb, ...rest] = args;
  switch (verb) {
    case 'exec': if (rest.length !== 2) throw Error(usage); return remoteExec(project, rest[0], rest[1], { signal });
    case 'fanout': return fanout(project, JSON.parse(readFileSync(rest[0], 'utf8')), { signal });
    case 'task': return updateTask(project, JSON.parse(rest[0]));
    case 'state': return snapshot(project);
    case 'compact': return compactState(project);
    case 'decision': return queueDecision(project, JSON.parse(rest[0]));
    case 'answer': return resolveDecision(project, rest[0], rest[1]);
    case 'evidence': return recordEvidence(project, JSON.parse(rest[0]));
    case 'verify': return verifyEvidence(project, rest[0]);
    case 'watch-once': return superviseOnce(project);
    case 'supervise': await supervise(project, signal); return { status: 'STOPPED' };
    default: return { usage };
  }
}
if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  const c = new AbortController();
  process.once('SIGTERM', () => c.abort());
  process.once('SIGINT', () => c.abort());
  handleOps(process.argv.slice(2), process.cwd(), c.signal).then(x => {
    console.log(JSON.stringify(x, null, 2));
  }, err => { console.error(err.message); process.exitCode = 1; });
}