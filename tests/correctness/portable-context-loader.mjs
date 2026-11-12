// Substitute model/UI boundaries only; run the production auto-compact controller.
export async function resolve(specifier, context, nextResolve) {
  if (!context.parentURL?.endsWith('/src/services/compact/autoCompact.ts')) return nextResolve(specifier, context);
  const stubs = {
    'bun:bundle': 'export const feature=()=>false;',
    'src/bootstrap/state.js': 'export const markPostCompaction=()=>{};',
    '../../bootstrap/state.js': 'export const getSdkBetas=()=>[];',
    '../../utils/config.js': 'export const getGlobalConfig=()=>({autoCompactEnabled:globalThis.__portableCompact.enabled});',
    '../../utils/context.js': 'export const getContextWindowForModel=()=>200000;',
    '../../utils/debug.js': 'export const logForDebugging=()=>{};',
    '../../utils/envUtils.js': 'export const isEnvTruthy=v=>v==="1"||v==="true";',
    '../../utils/errors.js': 'export const hasExactErrorMessage=(e,m)=>e?.message===m;',
    '../../utils/log.js': 'export const logError=()=>{};',
    '../../utils/tokens.js': 'export const tokenCountWithEstimation=()=>globalThis.__portableCompact.tokens;',
    '../analytics/growthbook.js': 'export const getFeatureValue_CACHED_MAY_BE_STALE=(_k,v)=>v;',
    '../api/future.js': 'export const getMaxOutputTokensForModel=()=>20000;',
    '../api/promptCacheBreakDetection.js': 'export const notifyCompaction=()=>{};',
    '../SessionMemory/sessionMemoryUtils.js': 'export const setLastSummarizedMessageId=()=>{};',
    './compact.js': `export const ERROR_MESSAGE_USER_ABORT='user aborted'; export const compactConversation=async(...args)=>{const h=globalThis.__portableCompact; h.calls.push(args); if(h.fail)throw new Error('summary transport failed'); return h.result;};`,
    './postCompactCleanup.js': 'export const runPostCompactCleanup=()=>{};',
    './sessionMemoryCompact.js': 'export const trySessionMemoryCompaction=async()=>{if(globalThis.__portableCompact.sessionFail)throw new Error("memory snapshot unavailable");return globalThis.__portableCompact.sessionResult;};',
  };
  if (stubs[specifier]) return { url: 'data:text/javascript,' + encodeURIComponent(stubs[specifier]), shortCircuit: true };
  if (specifier.endsWith('.js')) return { url: new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
