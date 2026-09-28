// Focused resilience and adjacent regression gates. No model credentials needed.
// The only optional skip is for the incomplete offline source evidence package;
// an ordinary full repository run also checks native command registration.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const tests = [
  'tests/foundry/productivity.test.ts', 'tests/foundry/swarm.test.ts',
  'tests/foundry/swarm-http.test.ts', 'tests/foundry/swarm-evidence.test.ts',
  'tests/foundry/resilience.test.ts', 'tests/foundry/resilience-e2e.test.ts',
];
const flags = process.argv.slice(2);
if (flags.some(f => f !== '--source-subset')) throw new Error('Only --source-subset is supported');
const skip = flags.includes('--source-subset') ? ['--test-skip-pattern=native slash commands'] : [];
if (skip.length) console.error('SOURCE SUBSET: native command registration test excluded; full application not validated.');
const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', ...skip, ...tests], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const remote = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests/research-jobs', '-v'], { cwd: root, stdio: 'inherit' });
if (remote.error) throw remote.error;
process.exitCode = remote.status ?? 1;
