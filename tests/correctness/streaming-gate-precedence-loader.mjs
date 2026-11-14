// Load the real GrowthBook gate resolution and query config builder; isolate
// only leaf config/auth/analytics modules so flag-precedence scenarios are
// deterministic and run offline. Mirrors streaming-tool-executor-loader.mjs.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const GROWTHBOOK = '/src/services/analytics/growthbook.ts';
const QUERY_CONFIG = '/src/query/config.ts';

export async function load(url, context, nextLoad) {
  if (url.endsWith('.ts')) {
    return {
      format: 'module',
      source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }),
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}

export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL ?? '';
  if (!parent.endsWith(GROWTHBOOK) && !parent.endsWith(QUERY_CONFIG)) {
    return nextResolve(specifier, context);
  }

  // Real modules under test: remap their .js specifiers to the .ts sources.
  if (
    specifier === '../services/analytics/growthbook.js' ||
    specifier === '../utils/envUtils.js' ||
    specifier === '../../utils/signal.js'
  ) {
    return {
      url: new URL(specifier.replace(/\.js$/, '.ts'), parent).href,
      shortCircuit: true,
    };
  }

  const stubs = {
    '../../bootstrap/state.js':
      `export const getIsNonInteractiveSession = () => false;` +
      ` export const getSessionTrustAccepted = () => false;`,
    '../bootstrap/state.js': `export const getSessionId = () => 'gate-precedence-session';`,
    '../../constants/keys.js': `export const getGrowthBookClientKey = () => 'test-client-key';`,
    '../../utils/config.js': [
      `export const getGlobalConfig = () => (globalThis.__fcGateTestConfig ?? {});`,
      `export const saveGlobalConfig = apply => { globalThis.__fcGateTestConfig = apply(globalThis.__fcGateTestConfig ?? {}); };`,
      `export const checkHasTrustDialogAccepted = () => false;`,
    ].join('\n'),
    '../../utils/debug.js': `export const logForDebugging = () => {};`,
    '../../utils/errors.js':
      `export const toError = error => (error instanceof Error ? error : new Error(String(error)));`,
    '../../utils/http.js': `export const getAuthHeaders = () => ({});`,
    '../../utils/log.js': `export const logError = () => {};`,
    '../../utils/slowOperations.js': `export const jsonStringify = JSON.stringify;`,
    '../../utils/user.js': `export const getUserForGrowthBook = () => ({});`,
    './firstPartyEventLogger.js': [
      `export const is1PEventLoggingEnabled = () => globalThis.__fcGateTest1PEnabled === true;`,
      `export const logGrowthBookExperimentTo1P = () => {};`,
    ].join('\n'),
  };
  const source = stubs[specifier];
  if (source !== undefined) {
    return {
      url: 'data:text/javascript,' + encodeURIComponent(source),
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
