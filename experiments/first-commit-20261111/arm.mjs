// Load unchanged production code from the requested checkout. Only peripheral
// UI/analytics and the tool-generator boundary are adapted, identically in A/B.
import { register } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
const run = promisify(execFile);
const [mode, checkout, inputPath, outputDir, scenario = 'healthy'] = process.argv.slice(2);
mkdirSync(outputDir, { recursive: true });
const sha = s => createHash('sha256').update(s).digest('hex');
const load = p => import(pathToFileURL(join(checkout, p)).href);
const save = value => writeFileSync(join(outputDir, 'result.json'), JSON.stringify(value, null, 2) + '\n');
if (mode === 'context') {
  register('./tool-result-budget-loader.mjs', import.meta.url);
  process.env.FUTURE_CODE_TEST_RESULT_DIR = resolve(outputDir);
  delete process.env.FUTURE_CODE_TOOL_RESULT_BUDGET_CHARS;
  delete process.env.FUTURE_CODE_DISABLE_TOOL_RESULT_BUDGET;
  const storage = await load('src/utils/toolResultStorage.ts');
  const contents = JSON.parse(readFileSync(inputPath, 'utf8'));
  // Apply the EXISTING per-tool persistence to both versions first. Ignoring
  // this layer would unfairly inflate the baseline's request payload.
  const toolUses = contents.map((_, i) => ({ type: 'tool_use', id: `result-${i}`, name: 'Bash', input: { command: `frozen-command-${i}` } }));
  const blocks = [];
  for (let i = 0; i < contents.length; i++) blocks.push(await storage.processPreMappedToolResultBlock(
    { type: 'tool_result', tool_use_id: `result-${i}`, content: contents[i] }, 'Bash', 50_000));
  const messages = [{ type: 'assistant', message: { id: 'batch', role: 'assistant', content: toolUses } },
    { type: 'user', message: { role: 'user', content: blocks } }];
  const original = JSON.stringify(messages);
  const before = performance.now();
  const state = scenario === 'legacy-flag-on' ? storage.createContentReplacementState() : storage.provisionContentReplacementState();
  const view = state ? await storage.enforceToolResultBudget(messages, state, new Set(['Read'])) : { messages, newlyReplaced: [] };
  const elapsedMs = performance.now() - before;
  const replay = state ? await storage.enforceToolResultBudget(messages, state, new Set(['Read'])) : view;
  const receipts = contents.map((content, i) => {
    const path = storage.getToolResultPath(`result-${i}`, false);
    return { id: `result-${i}`, rawBytes: Buffer.byteLength(content), sha256: sha(content),
      persisted: existsSync(path), persistedSha256: existsSync(path) ? sha(readFileSync(path)) : null,
      fullContentRetained: existsSync(path) ? readFileSync(path, 'utf8') === content : JSON.stringify(view.messages).includes(JSON.stringify(content).slice(1, -1)) };
  });
  writeFileSync(join(outputDir, 'request-view.json'), JSON.stringify(view.messages, null, 2));
  save({ mode, scenario, enforcementEnabled: !!state, targetCharacters: storage.getPerMessageBudgetLimit(),
    inputBytes: Buffer.byteLength(original), requestBytes: Buffer.byteLength(JSON.stringify(view.messages)),
    elapsedMs, replacedCount: view.newlyReplaced.length, receiptCount: receipts.length, receipts,
    originalsUnchanged: JSON.stringify(messages) === original,
    replayIdentical: JSON.stringify(replay.messages) === JSON.stringify(view.messages),
    fullReadbackIdentical: receipts.every(r => r.fullContentRetained), liveModelCalls: 0 });
  process.exit(0);
}
register('./streaming-tool-executor-loader.mjs', import.meta.url);
const { StreamingToolExecutor } = await load('src/services/tools/StreamingToolExecutor.ts');
const paired = (id, content, error = false) => ({ message: { type: 'user', message: { content: [
  { type: 'tool_result', tool_use_id: id, content, ...(error ? { is_error: true } : {}) },
] } } });
let progress = new Set();
const tools = ['Read', 'Write', 'BenchmarkCheck'].map(name => ({ name,
  inputSchema: { safeParse: data => ({ success: true, data }) },
  isConcurrencySafe: () => name !== 'Write', interruptBehavior: () => 'cancel' }));
const context = { abortController: new AbortController(), options: { tools, mcpClients: [] },
  setInProgressToolUseIDs: fn => { progress = fn(progress); }, setHasInterruptibleToolInProgress: () => {} };
const evidence = [];
const event = value => appendFileSync(join(outputDir, 'events.jsonl'), JSON.stringify(value) + '\n');
const add = (executor, id, name, input = {}) => executor.addTool({ id, name, input }, { uuid: `assistant-${id}`, message: { id: `response-${id}` } });
const drain = async executor => {
  const blocks = [];
  for await (const update of executor.getRemainingResults()) if (update.message?.type === 'user')
    for (const b of update.message.message.content) if (b.type === 'tool_result') { blocks.push(b); event({ kind: 'result', ...b }); }
  return blocks;
};
if (mode === 'executor') {
  const artifact = join(outputDir, 'artifact.txt');
  globalThis.__futureStreamingToolTest = async function* (call) {
    if (call.id === 'followup') {
      const actual = await run(process.execPath, ['-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1],"utf8"))', artifact]);
      yield paired(call.id, actual.stdout); return;
    }
    if (scenario === 'stream-throw-before-result') throw new Error('injected result framing failure before result');
    if (scenario === 'schema-preflight-throw') { yield paired(call.id, 'schema rejected', true); return; }
    await run(process.execPath, ['-e', 'require("node:fs").appendFileSync(process.argv[1],"verified-effect\\n")', artifact]);
    event({ kind: 'effect', id: call.id, artifactSha256: sha(readFileSync(artifact)) });
    if (scenario === 'stream-throw-after-effect') throw new Error('injected result framing failure after actual write');
    if (scenario === 'empty-stream-after-effect') return;
    const update = paired(call.id, 'actual subprocess write completed', scenario === 'ordinary-error-result');
    if (scenario === 'context-modifier-throw') update.contextModifier = { modifyContext() { throw new Error('injected context update failure'); } };
    yield update;
  };
  // The pre-effect and schema cases need a known, unchanged artifact so a
  // subsequent independent Read has meaningful work to complete.
  if (['stream-throw-before-result', 'schema-preflight-throw'].includes(scenario)) writeFileSync(artifact, 'unchanged-evidence\n');
  if (scenario === 'schema-preflight-throw') tools.find(t => t.name === 'Write').inputSchema.safeParse = () => { throw new Error('injected preflight schema predicate exception'); };
  const executor = new StreamingToolExecutor(tools, () => {}, context);
  const started = performance.now();
  add(executor, 'operation', 'Write'); add(executor, 'followup', 'Read');
  evidence.push(...await drain(executor));
  const actual = existsSync(artifact) ? readFileSync(artifact, 'utf8') : null;
  const expected = ['stream-throw-before-result', 'schema-preflight-throw'].includes(scenario) ? 'unchanged-evidence\n' : 'verified-effect\n';
  const operation = evidence.find(b => b.tool_use_id === 'operation');
  const followup = evidence.find(b => b.tool_use_id === 'followup');
  const expectedError = scenario !== 'healthy';
  save({ mode, scenario, elapsedMs: performance.now() - started, operationPaired: !!operation,
    errorReportedWhenRequired: !expectedError || operation?.is_error === true,
    followupCompleted: followup?.content === expected && !followup?.is_error,
    exactOnceArtifact: actual === expected, resultCount: evidence.length,
    inProgressEmpty: progress.size === 0, parentNotAborted: !context.abortController.signal.aborted,
    accepted: !!operation && (!expectedError || operation.is_error === true) && followup?.content === expected && actual === expected,
    artifactSha256: actual === null ? null : sha(actual), liveModelCalls: 0 });
} else if (mode === 'humaneval') {
  const cases = JSON.parse(readFileSync(inputPath, 'utf8'));
  globalThis.__futureStreamingToolTest = async function* (call) {
    const c = cases[call.input.index];
    const program = c.prompt + c.canonical_solution + '\n' + c.test + `\ncheck(${c.entry_point})\n`;
    const result = await run('python3', ['-I', '-c', program], { cwd: outputDir, timeout: 10000, maxBuffer: 1_000_000 });
    event({ kind: 'test-pass', id: call.id, programSha256: sha(program) });
    yield paired(call.id, JSON.stringify({ taskId: c.task_id, officialTestsPassed: true, stdout: result.stdout, stderr: result.stderr }));
    if (scenario === 'stream-throw-after-result' && call.input.index === 32) throw new Error('injected framing failure after HumanEval/32 check');
  };
  const started = performance.now();
  for (let i = 0; i < cases.length; i++) {
    const executor = new StreamingToolExecutor(tools, () => {}, context);
    add(executor, cases[i].task_id, 'BenchmarkCheck', { index: i });
    const blocks = await drain(executor); evidence.push(...blocks);
    if (!blocks.some(b => b.tool_use_id === cases[i].task_id)) event({ kind: 'missing-result', id: cases[i].task_id });
  }
  save({ mode, scenario, elapsedMs: performance.now() - started, officialTasks: cases.length,
    resultCount: evidence.length, explicitErrors: evidence.filter(b => b.is_error).length,
    allPaired: cases.every(c => evidence.some(b => b.tool_use_id === c.task_id)),
    liveModelCalls: 0, generationScore: null, interpretation: 'Canonical solution execution/recovery replay; NOT HumanEval pass@1.' });
} else throw new Error(`Unknown mode: ${mode}`);
