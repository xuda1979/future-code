// Exercise the production diagnostics tracker; isolate only IDE transport and
// unrelated UI/path services so transport stalls are deterministic offline.
export async function resolve(specifier, context, nextResolve) {
  if (!context.parentURL?.endsWith('/src/services/diagnosticTracking.ts')) return nextResolve(specifier, context);
  if (specifier === '../utils/foregroundPreparation.js') return {
    url: new URL('../utils/foregroundPreparation.ts', context.parentURL).href, shortCircuit: true,
  };
  const stubs = {
    figures: `export default {cross:'x',warning:'!',info:'i',star:'*',bullet:'.'};`,
    'src/utils/log.js': `export const logError=()=>{};`,
    '../services/mcp/client.js': `export const callIdeRpc=(...args)=>globalThis.__diagnosticRpc(...args);`,
    '../utils/errors.js': `export class FutureError extends Error {};`,
    '../utils/file.js': `export const normalizePathForComparison=p=>p; export const pathsEqual=(a,b)=>a===b;`,
    '../utils/ide.js': `export const getConnectedIdeClient=clients=>clients.find(c=>c.type==='connected');`,
    '../utils/slowOperations.js': `export const jsonParse=JSON.parse;`,
  };
  return stubs[specifier] === undefined ? nextResolve(specifier, context) : {
    url: 'data:text/javascript,' + encodeURIComponent(stubs[specifier]), shortCircuit: true,
  };
}
