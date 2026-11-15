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
// --list-models / --models: print the CMRI + Huanxin model catalog and exit
// before any CLI initialization (so it works with no config/env at all).
const listModelsOnly =
  process.argv.includes('--list-models') || process.argv.includes('--models');
const modelEndpointOnly = process.argv[2] === '--model-endpoint';
if (modelEndpointOnly) {
  import('../commands/model/endpointCli.ts').then(({ runModelEndpointCLI }) => {
    console.log(runModelEndpointCLI(process.argv.slice(3)));
  }).catch(() => {
    console.error('Could not configure model endpoint. Use --model-endpoint --help and check the key environment variable and configuration directory.');
    process.exitCode = 1;
  });
}
if (listModelsOnly && !modelEndpointOnly) {
  import('../utils/model/cmriHuanxinCatalog.js').then(({ renderCatalogText }) => {
    console.log(renderCatalogText());
    process.exit(0);
  });
}
// Model default is CMRI GLM-5.3 (see src/utils/model/cmriHuanxinCatalog.ts
// for the full cmri/huanxin catalog); the base URL + API key are always
// supplied externally (never hardcoded here).
setDefaultEnv('FUTURE_MODEL', 'GLM-5.3');
setDefaultEnv('FUTURE_SMALL_FAST_MODEL', 'GLM-5.3');
setDefaultEnv('FUTURE_DEFAULT_SONNET_MODEL', 'GLM-5.3');
setDefaultEnv('FUTURE_DEFAULT_OPUS_MODEL', 'GLM-5.3');
setDefaultEnv('FUTURE_DEFAULT_HAIKU_MODEL', 'GLM-5.3');
setDefaultEnv('FUTURE_CODE_SUBAGENT_MODEL', 'GLM-5.3');
setDefaultEnv('FUTURE_CODE_EFFORT_LEVEL', 'max');
// Disable telemetry & non-essential traffic so the CLI never phones home.
setDefaultEnv('FUTURE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1');
setDefaultEnv('DISABLE_TELEMETRY', '1');
setDefaultEnv('NODE_ENV', 'production');

// Now hand off to the real CLI entrypoint (unless we are only listing models).
if (!modelEndpointOnly && !listModelsOnly && process.argv[2] === '--ops') {
  import('../ops/cli.mjs').then(({ handleOps }) => {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.once('SIGTERM', () => controller.abort());
    return handleOps(process.argv.slice(3), process.cwd(), controller.signal)
      .then(value => console.log(JSON.stringify(value, null, 2)));
  }).catch(error => { console.error(error); process.exitCode = 1; });
} else if (!modelEndpointOnly && !listModelsOnly) {
  import('./cli.tsx');
}
