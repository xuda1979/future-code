import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isShellObservation } from '../../utils/shellActivity.ts';

/** A request-local activity diagnostic, never a progress/acceptance verdict.
 * It observes actual paired tool receipts even if the model never ends its
 * turn. No model calls, filesystem scans, retained transcript cache or job
 * cancellation. Unknown successful tools conservatively end the window. */
interface ActivityMessage {
  type: string;
  isMeta?: boolean;
  origin?: unknown;
  message?: unknown;
}
type Block = Record<string, unknown>;
const OBSERVATIONS = new Set(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'ToolSearch',
  'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'EnterPlanMode', 'ExitPlanMode',
  'ListMcpResources', 'ReadMcpResource']);
const MAX_MESSAGES = 128;
const MAX_BLOCKS = 256;
const OBSERVATION_REVIEW = 12;
const REPEAT_REVIEW = 3;

function content(message: ActivityMessage): unknown {
  const body = message.message;
  return body && typeof body === 'object' && 'content' in body ? body.content : undefined;
}
function isBlock(value: unknown): value is Block {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Match the file tools' lexical expansion without loading their I/O layer.
 * Original transcript inputs remain untouched; symlinks are not resolved. */
function expandedPath(value: unknown, cwd: string): string | null {
  if (typeof value !== 'string' || value.includes('\0')) return null;
  const path = value.trim();
  if (path === '~') return homedir().normalize('NFC');
  return (path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(cwd, path)).normalize('NFC');
}

/** Exact canonical identity only within a small budget. Oversized/unsupported
 * values disable duplicate detection; a shared truncated prefix is not proof
 * of equal receipts. Digests and counts, never payloads, leave this module. */
function identity(value: unknown): string | null {
  let remaining = 32_768;
  let nodes = 2048;
  const tokens: string[] = [];
  function add(token: string): boolean {
    remaining -= token.length;
    if (remaining < 0) return false;
    tokens.push(token);
    return true;
  }
  function visit(item: unknown, depth: number): boolean {
    if (--nodes < 0 || depth > 8) return false;
    if (typeof item === 'string') return item.length <= remaining && add(JSON.stringify(item));
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return add(JSON.stringify(item));
    if (Array.isArray(item)) {
      if (item.length > 128 || !add('[')) return false;
      for (const child of item) if (!visit(child, depth + 1) || !add(',')) return false;
      return add(']');
    }
    if (isBlock(item)) {
      if (![null, Object.prototype].includes(Object.getPrototypeOf(item))) return false;
      const keys = Object.keys(item);
      return keys.length <= 128 && add('{') && keys.sort().every(key =>
        key.length <= remaining && add(JSON.stringify(key)) && add(':') && visit(item[key], depth + 1) && add(',')) && add('}');
    }
    return false;
  }
  return visit(value, 0) ? createHash('sha256').update(tokens.join('')).digest('hex') : null;
}

/** Replaceable tail guidance. Historical messages and complete receipts stay
 * in their original order; this neither grants authority nor skips checks. */
export function actionFocusReview(messages: readonly ActivityMessage[], goalReportPath: string, cwd = process.cwd()): string | null {
  const reportPath = expandedPath(goalReportPath, cwd);
  const blocks: { value: Block; role: string }[] = [];
  for (let i = messages.length - 1; i >= Math.max(0, messages.length - MAX_MESSAGES) && blocks.length < MAX_BLOCKS; i--) {
    const message = messages[i]!;
    const body = content(message);
    const array = Array.isArray(body) ? body : null;
    // Conservatively stop at oversized/ambiguous transcript structures;
    // never scan an unbounded array to discover a human or tool boundary.
    if (array && array.length > MAX_BLOCKS) break;
    // A fresh human request scopes the diagnostic; meta reminders and tool
    // results do not. Do not borrow child-message evidence as host activity.
    if (message.type === 'user' && message.isMeta !== true && message.origin === undefined &&
      (typeof body === 'string' || array && !array.some(item => isBlock(item) && item.type === 'tool_result'))) break;
    if (message.origin !== undefined || !array) continue;
    for (let j = Math.min(array.length, MAX_BLOCKS) - 1; j >= 0 && blocks.length < MAX_BLOCKS; j--) {
      if (isBlock(array[j])) blocks.push({ value: array[j], role: message.type });
    }
  }
  blocks.reverse();
  const calls = new Map<string, { call: Block; index: number }>();
  const ambiguous = new Set<string>();
  const resultCounts = new Map<string, number>();
  blocks.forEach(({ value, role }, index) => {
    if (role === 'assistant' && value.type === 'tool_use' && typeof value.id === 'string') {
      if (calls.has(value.id)) ambiguous.add(value.id);
      calls.set(value.id, { call: value, index });
    }
    if (role === 'user' && value.type === 'tool_result' && typeof value.tool_use_id === 'string')
      resultCounts.set(value.tool_use_id, (resultCounts.get(value.tool_use_id) ?? 0) + 1);
  });
  let observations = 0;
  let repeatedFailure = 0;
  let repeatedObservation = 0;
  const seen = new Map<string, { receipt: string; count: number; failed: boolean }>();
  blocks.forEach(({ value, role }, index) => {
    if (role !== 'user' || value.type !== 'tool_result' || typeof value.tool_use_id !== 'string') return;
    const entry = calls.get(value.tool_use_id);
    if (!entry || entry.index >= index || ambiguous.has(value.tool_use_id) || resultCounts.get(value.tool_use_id) !== 1) return;
    const call = entry.call;
    if (typeof call.name !== 'string' || !isBlock(call.input)) return;
    const note = reportPath !== null && ['Write', 'Edit', 'MultiEdit'].includes(call.name) &&
      expandedPath(call.input.file_path, cwd) === reportPath;
    const waiting = call.name === 'TaskOutput';
    const observation = OBSERVATIONS.has(call.name) || note ||
      call.name === 'Bash' && isShellObservation(call.input.command);
    const failed = value.is_error === true;
    if (!failed && !observation && !waiting) {
      // A completed change/experiment is a reason to re-evaluate, not proof
      // of correctness. Independent acceptance remains elsewhere.
      observations = repeatedFailure = repeatedObservation = 0;
      seen.clear();
      return;
    }
    if (observation) observations++;
    const request = identity([call.name, call.input]);
    const receipt = identity([failed, value.content]);
    if (!request) return;
    if (!receipt) { seen.delete(request); return; }
    const previous = seen.get(request);
    const count = previous?.receipt === receipt ? previous.count + 1 : 1;
    seen.set(request, { receipt, count, failed });
  });
  // Recompute so changed evidence disarms its old warning, but interleaved
  // read-only diagnostics cannot hide a repeated failed operation.
  for (const record of seen.values()) {
    if (record.failed) repeatedFailure = Math.max(repeatedFailure, record.count);
    else repeatedObservation = Math.max(repeatedObservation, record.count);
  }
  const findings: string[] = [];
  if (repeatedFailure >= REPEAT_REVIEW) findings.push(`The same failed request and receipt repeated ${repeatedFailure} times.`);
  else if (repeatedObservation >= REPEAT_REVIEW) findings.push(`The same observation request and receipt repeated ${repeatedObservation} times.`);
  if (observations >= OBSERVATION_REVIEW) findings.push(`${observations} observation/planning receipts without a completed change or experiment call in this bounded window.`);
  if (!findings.length) return null;
  return '[Host Action Review — activity diagnostic, not a stall verdict]\n' + findings.join(' ') +
    ' Identify the remaining gap from the best existing artifact to the requested outcome. Execute the smallest relevant change or discriminating check, or deliver the requested analysis; reuse working components. Read-only goals do not authorize mutations. ' +
    'If more discovery is necessary, name the specific uncertainty that could change that action. For repeated failures, reconcile existing external work and diagnose a prerequisite before retrying. ' +
    'Preserve useful deep reasoning, healthy running jobs, permissions, budgets and independent acceptance. Unchanged polling alone is not failure; use a durable wait/notification or work on an independent prerequisite. ' +
    'These receipt counts do not establish correctness or justify skipping final verification.';
}
