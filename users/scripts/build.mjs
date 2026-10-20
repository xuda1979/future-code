import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const target = process.argv[2] || ({ win32: 'windows', darwin: 'macos', linux: 'ubuntu' }[process.platform] + '-' + process.arch);
const supported = ['windows-x64', 'macos-arm64', 'macos-x64', 'ubuntu-x64'];
if (!supported.includes(target)) throw new Error('Unsupported release target: ' + target);
const nativeTarget = { win32: 'windows', darwin: 'macos', linux: 'ubuntu' }[process.platform] + '-' + process.arch;
if (target !== nativeTarget) throw new Error('Build on the target OS/architecture to include correct native dependencies.');
const config = readFileSync(join(root, 'client/config.mjs'), 'utf8');
if (!config.includes('BEGIN PUBLIC KEY')) throw new Error('Configure the public verification key before building.');
const outputDir = resolve(root, '../dist/users', target); mkdirSync(outputDir, { recursive: true });
const binary = join(outputDir, 'future-code' + (process.platform === 'win32' ? '.exe' : ''));
const bun = process.env.BUN_BIN || 'bun';
function run(command, args) {
  const result = spawnSync(command, args, { cwd: resolve(root, '..'), stdio: 'inherit', shell: false });
  if (result.error || result.status !== 0) throw new Error('Build/check failed: ' + (result.error?.message || result.status));
}
run(bun, ['build', 'users/entrypoint.ts', '--compile', '--minify', '--bytecode', '--format=cjs', '--outfile=' + binary]);
run(binary, ['--version']); run(binary, ['--help']); run(binary, ['license', 'status']);
// Distribute only compiled output, not the repository or source maps.
writeFileSync(join(outputDir, 'README.txt'), 'Future Code commercial build\nActivate: future-code license activate\nModel API usage is billed separately.\nSupport: exutechnology@gmail.com\n');
writeFileSync(join(outputDir, 'SHA256SUMS'), createHash('sha256').update(readFileSync(binary)).digest('hex') + '  ' + binary.split(/[\\/]/).pop() + '\n');
if (!existsSync(binary)) throw new Error('Missing binary.');
console.log('Candidate built; public release requires the checks in users/README.md.');
