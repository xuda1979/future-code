// Bundled entry point: prelude shims + env defaults + CLI.
declare const MACRO: { VERSION: string; ISSUES_EXPLAINER: string; [k: string]: string };
const globalAny: any = globalThis as any;
if (!globalAny.MACRO) {
  globalAny.MACRO = new Proxy({
    VERSION: '1.0',
    ISSUES_EXPLAINER: '',
  }, {
    get(t, p: string) {
      if (p in t) return (t as any)[p];
      return '';
    }
  });
}
if (!globalAny.feature) {
  (globalThis as any).feature = (_name: string) => false;
}

// No explicit URLs or API keys are baked into the binary.
// Connection settings (FUTURE_BASE_URL / FUTURE_API_KEY) MUST be
// provided by the environment — normally set by the `future-code` wrapper
// (installed by install.sh), which reads them from deepseek.env.
function setDefaultEnv(key: string, value: string) {
  if (!process.env[key]) process.env[key] = value;
}
// Model default is the DeepSeek v4 flash tier; the base URL + API key are
// always supplied externally (never hardcoded here).
setDefaultEnv('FUTURE_MODEL', 'deepseek-v4-flash');
setDefaultEnv('FUTURE_SMALL_FAST_MODEL', 'deepseek-v4-flash');
setDefaultEnv('FUTURE_DEFAULT_SONNET_MODEL', 'deepseek-v4-pro[1m]');
setDefaultEnv('FUTURE_DEFAULT_OPUS_MODEL', 'deepseek-v4-pro[1m]');
setDefaultEnv('FUTURE_DEFAULT_HAIKU_MODEL', 'deepseek-v4-flash');
setDefaultEnv('FUTURE_CODE_SUBAGENT_MODEL', 'deepseek-v4-flash');
setDefaultEnv('FUTURE_CODE_EFFORT_LEVEL', 'max');
// Disable telemetry & non-essential traffic so the CLI never phones home.
setDefaultEnv('FUTURE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1');
setDefaultEnv('DISABLE_TELEMETRY', '1');
setDefaultEnv('NODE_ENV', 'production');

// Now hand off to the real CLI entrypoint.
import('./cli.tsx');
