// Load the real executor and abort propagation; isolate only SDK/UI services
// and the tool generator so failure/order/effect scenarios are deterministic.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
export async function load(url, context, nextLoad) {
  if (url.endsWith('/src/services/tools/StreamingToolExecutor.ts')) return {
    format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true,
  };
  return nextLoad(url, context);
}
export async function resolve(specifier, context, nextResolve) {
  if (!context.parentURL?.endsWith('/src/services/tools/StreamingToolExecutor.ts')) return nextResolve(specifier, context);
  if (specifier === '../../utils/abortController.js') return {
    url: new URL('../../utils/abortController.ts', context.parentURL).href, shortCircuit: true,
  };
  const stubs = {
    'src/utils/messages.js': `export const createUserMessage = value => ({type:'user',message:{content:value.content},...Object.fromEntries(Object.entries(value).filter(([key])=>key!=='content'))}); export const REJECT_MESSAGE='User rejected tool use'; export const withMemoryCorrectionHint=x=>x;`,
    '../../Tool.js': `export const findToolByName=(tools,name)=>tools.find(tool=>tool.name===name);`,
    '../../tools/BashTool/toolName.js': `export const BASH_TOOL_NAME='Bash';`,
    './toolExecution.js': `export async function* runToolUse(...args) { yield* globalThis.__futureStreamingToolTest(...args); }`,
  };
  return stubs[specifier] === undefined ? nextResolve(specifier, context) : {
    url: 'data:text/javascript,' + encodeURIComponent(stubs[specifier]), shortCircuit: true,
  };
}
