import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Small operational hints, never authority, a health check or acceptance.
 * Kept beside this session's goal so a lossy summary/restart need not rediscover
 * the known artifact, job identity and next action from a growing worklog. */
interface Goal { goal: string; revision?: number; state: string }
export const MAX_WORK_STATE_BYTES = 16_384;
interface RecordValue { [key: string]: unknown }
function object(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 &&
    Buffer.byteLength(value) <= 2048 && !value.includes('\0');
}
function fields(value: unknown, names: string[]): value is RecordValue {
  return object(value) && Object.keys(value).length === names.length && names.every(name => text(value[name]));
}
function valid(value: unknown): value is RecordValue {
  if (!object(value) || value.schema !== 1 || typeof value.goal !== 'string' || !value.goal.trim() ||
    Buffer.byteLength(value.goal) > 4096 || value.goal.includes('\0') ||
    !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || !text(value.nextAction)) return false;
  if (Object.keys(value).some(key => !['schema', 'goal', 'revision', 'baseline', 'activeJob', 'nextAction', 'attempts', 'metric'].includes(key))) return false;
  if (value.baseline !== undefined && !fields(value.baseline, ['artifact', 'evidence', 'contract'])) return false;
  if (value.activeJob !== undefined && !fields(value.activeJob, ['id', 'target', 'checkpoint', 'lastProgress', 'nextCheck'])) return false;
  if (value.metric !== undefined && !fields(value.metric, ['name', 'baseline', 'current', 'nextEvaluation'])) return false;
  return value.attempts === undefined || Array.isArray(value.attempts) && value.attempts.length <= 4 &&
    value.attempts.every(item => fields(item, ['action', 'result', 'next']));
}

/** No writes, directory scans, remote calls, cached verdicts or partial prefix
 * reads masquerading as a complete record. Unsafe/missing state cannot stop
 * useful work. The caller has already validated the host goal directory. */
export function formatGoalWorkState(goal: Goal, reportPath: string, longHorizon: boolean): string | null {
  if (goal.state !== 'ACTIVE') return null;
  const path = join(dirname(reportPath), 'work-state.json');
  let data: RecordValue | undefined;
  let diagnostic = '';
  let fd: number | undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_WORK_STATE_BYTES) throw new Error('invalid file');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_WORK_STATE_BYTES || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('changed file');
    const bytes = Buffer.alloc(MAX_WORK_STATE_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const n = readSync(fd, bytes, size, bytes.length - size, null);
      if (n === 0) break;
      size += n;
    }
    if (size > MAX_WORK_STATE_BYTES) throw new Error('oversized file');
    const value: unknown = JSON.parse(bytes.subarray(0, size).toString('utf8'));
    if (!valid(value)) throw new Error('invalid schema');
    if (value.goal !== goal.goal || value.revision !== (goal.revision ?? 1)) diagnostic = 'Recorded work state belongs to a different objective/revision; ignore it.';
    else data = value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') diagnostic = 'Recorded work state unavailable or invalid; preserve existing artifacts and reconstruct only the missing next-action facts.';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (!data && !longHorizon && !diagnostic) return null;
  const lines = ['[Recorded work state — operational hints, not acceptance evidence]'];
  if (diagnostic) lines.push(diagnostic);
  if (data) lines.push(JSON.stringify(data));
  if (longHorizon) lines.push(
    `Keep one bounded record at ${JSON.stringify(path)} (schema: 1, goal: exact root objective, revision: current revision, nextAction: one executable action; ` +
    'optional baseline: {artifact,evidence,contract}, activeJob: {id,target,checkpoint,lastProgress,nextCheck}, ' +
    'metric: {name,baseline,current,nextEvaluation}, attempts: up to 4 {action,result,next}; all leaf values are strings except schema/revision). ' +
    'Update only on a material result, launch, failure or changed next action; no per-call status journal or new setup prerequisite. Keep secrets out.');
  lines.push('Use the best existing artifact as the starting point. Reconcile the recorded job on its actual target before any replacement; a dead observer/port is not evidence that the job died. ' +
    'Check the specific changed prerequisite once, then execute the next action. Reuse exploration evidence only while its inputs match; final acceptance still needs independent checks. ' +
    'Track outcome improvement separately from health checks, steps and documentation. An observer turn ending does not impose a new job-duration budget.');
  return lines.join('\n');
}
