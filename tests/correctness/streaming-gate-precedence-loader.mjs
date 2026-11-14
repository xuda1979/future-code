// Load the real GrowthBook gate resolution and query config builder; isolate
// only leaf config/auth/analytics modules and bare npm imports so
// flag-precedence scenarios are deterministic and run offline (CI checkouts
// have no node_modules). Mirrors streaming-tool-executor-loader.mjs.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const GROWTHBOOK = '/src/services/analytics/growthbook.ts';
const QUERY_CONFIG = '/src/query/config.ts';
const ENV_UTILS = '/src/utils/envUtils.ts';

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
  if (
    !parent.endsWith(GROWTHBOOK) &&
    !parent.endsWith(QUERY_CONFIG) &&
    !parent.endsWith(ENV_UTILS)
  ) {
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

  // Lodash reimplementation for the real modules' call sites: deep structural
  // equality (cache/override comparison) and first-argument memoization with
  // a .cache Map (growthbook.ts clears it via memoized.cache?.clear?.()).
  const lodashIsEqual = `
const isEqual = (a, b) => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && isEqual(a[k], b[k]));
};
`;
  const lodashMemoize = `
const memoize = fn => {
  const cache = new Map();
  const wrapped = function (...args) {
    const key = args[0];
    if (!cache.has(key)) cache.set(key, fn.apply(this, args));
    return cache.get(key);
  };
  wrapped.cache = cache;
  return wrapped;
};
`;
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
    // Bare npm packages the real modules under test import; CI checkouts
    // install nothing, so these must resolve hermetically. None of the gate
    // scenarios construct a GrowthBook client — method stubs stay inert.
    '@growthbook/growthbook': [
      'export class GrowthBook {',
      '  init() { return Promise.resolve(); }',
      '  destroy() {}',
      '  getPayload() { return {}; }',
      '  async setPayload() {}',
      '  getFeatures() { return {}; }',
      '  async refreshFeatures() {}',
      '  subscribe() { return () => {}; }',
      '}',
    ].join('\n'),
    'lodash-es': lodashIsEqual + lodashMemoize + 'export { isEqual, memoize };',
    'lodash-es/memoize.js': lodashMemoize + 'export default memoize;',
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
