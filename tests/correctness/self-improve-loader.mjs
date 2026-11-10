// Keep Git, worktrees, subprocesses, prompts and ledger real. Only session
// settings/UI services and the test's managed-state home are substituted.
export async function resolve(specifier, context, nextResolve) {
  if (!context.parentURL?.includes('/src/services/selfImprove/')) return nextResolve(specifier, context);
  if (context.parentURL.endsWith('/scheduler.ts') && specifier === './cycle.js') return {
    url: 'data:text/javascript,' + encodeURIComponent(`export const maybeStartSelfImproveCycle=(...args)=>globalThis.__selfImproveSchedulerCheck(...args);`), shortCircuit: true,
  };
  const stubs = {
    './config.js': `export const SELF_IMPROVE_MARKER_ENV='FUTURE_SELF_IMPROVE_ACTIVE'; export const getSelfImproveConfig=()=>({enabled:false});`,
    '../../utils/debug.js': `export const logForDebugging=value=>globalThis.__selfImproveDebug?.(value);`,
    '../../utils/bundledMode.js': `export const isInBundledMode=()=>false;`,
  };
  if (specifier === 'node:os' && context.parentURL.endsWith('/cycle.ts')) return {
    url: 'data:text/javascript,' + encodeURIComponent(`export const homedir=()=>globalThis.__selfImproveTestHome;`), shortCircuit: true,
  };
  if (stubs[specifier]) return { url: 'data:text/javascript,' + encodeURIComponent(stubs[specifier]), shortCircuit: true };
  if (specifier.startsWith('./') && specifier.endsWith('.js')) return {
    url: new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href, shortCircuit: true,
  };
  return nextResolve(specifier, context);
}
