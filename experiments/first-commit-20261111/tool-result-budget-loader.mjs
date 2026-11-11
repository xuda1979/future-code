// Exercise the real storage/enforcement code in the offline Node gate. Only
// peripheral SDK/bootstrap/analytics imports are substituted; filesystem I/O,
// message grouping, replacement decisions and resume reconstruction are real.
export async function resolve(specifier, context, nextResolve) {
  if (!context.parentURL?.endsWith('/src/utils/toolResultStorage.ts')) {
    return nextResolve(specifier, context);
  }
  if (specifier === './toolResultBudgetPolicy.js' || specifier === '../constants/toolLimits.js') {
    return { url: new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href, shortCircuit: true };
  }
  const stubs = {
    '../bootstrap/state.js': `export const getOriginalCwd = () => process.env.FUTURE_CODE_TEST_RESULT_DIR; export const getSessionId = () => 'session';`,
    '../services/analytics/growthbook.js': `export const getFeatureValue_CACHED_MAY_BE_STALE = (_, fallback) => fallback;`,
    '../services/analytics/index.js': `export const logEvent = () => {};`,
    '../services/analytics/metadata.js': `export const sanitizeToolNameForAnalytics = name => name;`,
    './debug.js': `export const logForDebugging = () => {};`,
    './errors.js': `export const getErrnoCode = error => error.code; export const toError = error => error;`,
    './format.js': `export const formatFileSize = size => size + ' bytes';`,
    './log.js': `export const logError = () => {};`,
    './sessionStorage.js': `export const getProjectDir = cwd => cwd;`,
    './slowOperations.js': `export const jsonStringify = JSON.stringify;`,
  };
  const source = stubs[specifier];
  return source === undefined
    ? nextResolve(specifier, context)
    : { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
}
