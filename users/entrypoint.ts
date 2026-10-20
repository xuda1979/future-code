import { licenseCommand, requireLicense } from './client/license.mjs';

async function main() {
  if (process.argv.includes('--version')) { console.log('Future Code Users 0.1.0'); return; }
  if (await licenseCommand(process.argv.slice(2))) return;
  if (process.argv.length === 2) {
    console.log('Future Code — commercial desktop build\n\nActivate: future-code license activate\nStatus: future-code license status\nRelease device: future-code license deactivate\n\nAfter activation, pass ordinary Future Code arguments. Configure your own model provider using FUTURE_BASE_URL, FUTURE_API_KEY and FUTURE_MODEL. Model usage is billed by your provider.\nDownloads: https://future-code-downloads.david-hsu-8840.chatgpt.site');
    return;
  }
  // Show the real command parser without requiring a purchase. The build tests
  // this path so a healthy wrapper cannot hide a broken upstream CLI.
  if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) {
    await import('../src/entrypoints/cli-bundle.ts');
    return;
  }
  await requireLicense();
  // Keep upstream runtime untouched so users can be rebased onto main.
  await import('../src/entrypoints/cli-bundle.ts');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
