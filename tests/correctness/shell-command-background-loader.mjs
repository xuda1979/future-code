// Load the real process lifecycle; isolate only logging/configuration and the
// platform tree-kill adapter so cancellation is deterministic and side-effect free.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
export async function load(url, context, nextLoad) {
  if (url.endsWith('/src/utils/ShellCommand.ts')) return {
    format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true,
  };
  return nextLoad(url, context);
}
export async function resolve(specifier, context, nextResolve) {
  if (!context.parentURL?.endsWith('/src/utils/ShellCommand.ts')) return nextResolve(specifier, context);
  const stubs = {
    'tree-kill': 'export default (...args) => globalThis.__shellBackgroundKill?.(...args);',
    '../Task.js': 'export const generateTaskId=()=>"shell-background-test";',
    './format.js': 'export const formatDuration=value=>String(value);',
    './task/diskOutput.js': 'export const MAX_TASK_OUTPUT_BYTES=1000000, MAX_TASK_OUTPUT_BYTES_DISPLAY="1MB";',
    './task/TaskOutput.js': 'export class TaskOutput {}',
  };
  if (stubs[specifier]) return { url: 'data:text/javascript,' + encodeURIComponent(stubs[specifier]), shortCircuit: true };
  return nextResolve(specifier, context);
}
