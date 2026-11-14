// Loader for the streaming-vs-buffered tool admission benchmark.
// Loads the REAL StreamingToolExecutor and REAL runTools (toolOrchestration);
// stubs only the SDK tool generator (./toolExecution.js) so both arms run the
// identical simulated tool work, and the leaf UI/message helpers so the
// experiment runs offline and deterministically. Mirrors the isolation
// approach of tests/correctness/streaming-tool-executor-loader.mjs.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

// Shared stubs: the tool generator hook and tool lookup.
const RUN_TOOL_USE_STUB = `export async function* runToolUse(...args) { yield* globalThis.__benchToolRun(...args); }`;
const FIND_TOOL_STUB = `export const findToolByName=(tools,name)=>tools.find(t=>t.name===name);`;

// StreamingToolExecutor.ts parent stubs (mirrors correctness loader).
const EXECUTOR_STUBS = {
  'src/utils/messages.js': `export const createUserMessage = value => ({type:'user',message:{content:value.content},...Object.fromEntries(Object.entries(value).filter(([key])=>key!=='content'))}); export const REJECT_MESSAGE='User rejected tool use'; export const withMemoryCorrectionHint=x=>x;`,
  '../../Tool.js': FIND_TOOL_STUB,
  '../../tools/BashTool/toolName.js': `export const BASH_TOOL_NAME='Bash';`,
  './toolExecution.js': RUN_TOOL_USE_STUB,
};

// toolOrchestration.ts parent stubs: same generator hook; real generators.ts.
const ORCHESTRATION_STUBS = {
  '../../Tool.js': FIND_TOOL_STUB,
  './toolExecution.js': RUN_TOOL_USE_STUB,
};

export async function load(url, context, nextLoad) {
  if (
    url.endsWith('/src/services/tools/StreamingToolExecutor.ts') ||
    url.endsWith('/src/services/tools/toolOrchestration.ts')
  ) {
    return {
      format: 'module',
      source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), {
        mode: 'transform',
      }),
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}

export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL ?? '';
  const isExecutorParent = parent.endsWith('/src/services/tools/StreamingToolExecutor.ts');
  const isOrchestrationParent = parent.endsWith('/src/services/tools/toolOrchestration.ts');
  if (!isExecutorParent && !isOrchestrationParent) {
    return nextResolve(specifier, context);
  }
  // Real abort propagation util, resolved from .js specifier to the .ts source.
  if (isExecutorParent && specifier === '../../utils/abortController.js') {
    return {
      url: new URL('../../utils/abortController.ts', parent).href,
      shortCircuit: true,
    };
  }
  // Real concurrency-limited generator merge for the buffered arm.
  if (isOrchestrationParent && specifier === '../../utils/generators.js') {
    return {
      url: new URL('../../utils/generators.ts', parent).href,
      shortCircuit: true,
    };
  }
  const stubs = isExecutorParent ? EXECUTOR_STUBS : ORCHESTRATION_STUBS;
  const source = stubs[specifier];
  if (source !== undefined) {
    return {
      url: 'data:text/javascript,' + encodeURIComponent(source),
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
