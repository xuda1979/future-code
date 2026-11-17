// Execute the production generator body, with only process/UI services isolated.
// Node's TS stripper cannot parse this snapshot's JSX/dependency graph. The one
// presentation-only JSX expression is replaced; no control-flow body is copied.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

export function bashBackgroundFixture({ source, showUI = true, backgroundDisabled = false, spawnError } = {}) {
  source ??= readFileSync(new URL('../../../src/tools/BashTool/BashTool.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('async function* runShellCommand(');
  const end = source.indexOf('//# sourceMappingURL=', start);
  assert.ok(start >= 0 && end > start, 'load the actual production runShellCommand');
  const body = stripTypeScriptTypes(source.slice(start, end).replace('<BackgroundHint />', 'null'), { mode: 'transform' });
  let progress, timeout, finish;
  const timers = [];
  const counts = { executions: 0, foreground: 0, spawned: 0, backgrounded: 0, cleanup: 0, pollStops: 0, notified: 0, kills: 0 };
  const controller = new AbortController();
  const backgroundListeners = new Set();
  const shell = {
    status: 'running',
    result: new Promise(resolve => { finish = resolve; }),
    taskOutput: { taskId: 'task-1', stdoutToFile: true, outputFileRedundant: false, path: '/output', outputFileSize: 100 },
    cleanup() { counts.cleanup++; },
    onTimeout(callback) { timeout = callback; },
    onBackground(callback) { backgroundListeners.add(callback); return () => backgroundListeners.delete(callback); },
    background() {
      if (shell.status !== 'running') return false;
      shell.status = 'backgrounded';
      for (const callback of backgroundListeners) callback();
      return true;
    },
    kill() { counts.kills++; complete({ code: 137, interrupted: true }); },
  };
  const complete = (result = {}) => {
    shell.status = 'completed';
    finish({ stdout: 'actual command output', stderr: '', code: 0, interrupted: false, ...result });
  };
  controller.signal.addEventListener('abort', () => {
    if (controller.signal.reason !== 'interrupt') shell.kill();
  });
  const scope = {
    getDefaultTimeoutMs: () => 1000,
    isBackgroundTasksDisabled: backgroundDisabled,
    isAutobackgroundingAllowed: () => true,
    exec: async (_command, _signal, _type, options) => { counts.executions++; progress = options.onProgress; return shell; },
    shouldUseSandbox: () => false,
    spawnShellTask: async () => {
      counts.spawned++;
      if (spawnError) throw spawnError;
      shell.background(); return { taskId: 'task-1' };
    },
    backgroundExistingForegroundTask: () => {
      if (!shell.background()) return false;
      counts.backgrounded++; return true;
    },
    logEvent: () => {}, getCommandTypeForLogging: () => '', feature: () => false, getKairosActive: () => false,
    // Drive timing explicitly. These are lifecycle tests, not wall-time claims.
    PROGRESS_THRESHOLD_MS: 0, ASSISTANT_BLOCKING_BUDGET_MS: 15,
    setTimeout(callback, _ms, ...args) { timers.push(() => callback(...args)); return { unref() {} }; },
    clearTimeout() {},
    TaskOutput: { startPolling() {}, stopPolling() { counts.pollStops++; } },
    registerForeground: () => { counts.foreground++; return 'task-1'; },
    unregisterForeground() {}, markTaskNotified() { counts.notified++; },
  };
  const run = new Function(...Object.keys(scope), body + '\nreturn runShellCommand;')(...Object.values(scope));
  const generator = run({ input: { command: 'git push' }, abortController: controller,
    setAppState() {}, ...(showUI ? { setToolJSX() {} } : {}) });
  const turn = () => new Promise(resolve => setImmediate(resolve));
  async function startProgress() {
    const pending = generator.next();
    await turn();
    assert.equal(timers.length, 1);
    timers.shift()();
    await turn();
    progress('', '', 0, 0, false);
    assert.equal((await pending).value.type, 'progress');
  }
  return { generator, counts, shell, complete, controller, turn, startProgress, backgroundListeners,
    timeout: () => timeout(() => {}), progress: () => progress('partial', 'partial output', 1, 14, false) };
}
