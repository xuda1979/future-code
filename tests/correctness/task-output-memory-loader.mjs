// Exercise the production output buffers, disk writer and file-range readers.
// Isolate only session/config/logging services; the tail wrapper lets tests hold
// one I/O operation open without sleeping or depending on a slow filesystem.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

export async function load(url, context, nextLoad) {
  if (/\/src\/utils\/(?:CircularBuffer|fsOperations|stringUtils)\.ts$/.test(url)) {
    let source = readFileSync(new URL(url), 'utf8')
    if (url.endsWith('/fsOperations.ts')) {
      source = source.replace(/^(\s*)using (_ = slowLogging`[^`]*`)/gm, '$1const $2')
    }
    return {
      format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform' }), shortCircuit: true,
    }
  }
  return nextLoad(url, context);
}

export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL ?? '';
  if (!/\/src\/utils\/(?:task\/(?:TaskOutput|diskOutput)|fsOperations)\.ts$/.test(parent)) return nextResolve(specifier, context);
  const stubs = {
    '../debug.js': 'export const logForDebugging=()=>{};',
    '../shell/outputLimits.js': 'export const getMaxOutputLength=()=>30000;',
    '../../bootstrap/state.js': 'export const getSessionId=()=>"memory-test-session";',
    '../errors.js': 'export const getErrnoCode=e=>e?.code;',
    './errors.js': 'export const getErrnoCode=e=>e?.code;',
    '../log.js': 'export const logError=e=>{throw e;};',
    '../permissions/filesystem.js': 'export const getProjectTempDir=()=>process.env.FUTURE_CODE_TEST_OUTPUT_DIR;',
    './slowOperations.js': 'export const slowLogging=()=>({[Symbol.dispose](){}});',
  };
  if (stubs[specifier]) return { url: 'data:text/javascript,' + encodeURIComponent(stubs[specifier]), shortCircuit: true };
  if (parent.endsWith('/task/TaskOutput.ts') && specifier === '../fsOperations.js') {
    const source = new URL('../fsOperations.ts', parent).href;
    return { url: 'data:text/javascript,' + encodeURIComponent(`
      import * as fs from ${JSON.stringify(source)};
      export const readFileRange=fs.readFileRange;
      export const tailFile=(...args)=>globalThis.__taskOutputMemoryTail
        ? globalThis.__taskOutputMemoryTail(...args) : fs.tailFile(...args);
    `), shortCircuit: true };
  }
  if (specifier.endsWith('.js')) return { url: new URL(specifier.replace(/\.js$/, '.ts'), parent).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
