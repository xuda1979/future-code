// CPU-only optimizer lifecycle fixture. This is a scalar residual adapter,
// not Qwen, a quantum benchmark, or evidence of live-LLM productivity.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
const [input, output, countText] = process.argv.slice(2);
const count = Number(countText);
if (!input || !output || !Number.isSafeInteger(count) || count < 0 || count > 1000) throw new Error('invalid fixture arguments');
const state = JSON.parse(readFileSync(input, 'utf8'));
if (state.schema !== 1 || !['step', 'weight', 'bias', 'velocityWeight', 'velocityBias'].every(key => Number.isFinite(state[key]))) throw new Error('invalid checkpoint');
const train = [-2, -1, -0.5, 0.5, 1, 2];
const target = x => 1.7 * x - 0.3;
const predict = x => (0.2 + state.weight) * x + state.bias;
const mse = samples => samples.reduce((sum, x) => sum + (predict(x) - target(x)) ** 2, 0) / samples.length;
const before = mse([-1.75, -0.75, 0.25, 1.25]);
for (let i = 0; i < count; i++) {
  let gw = 0, gb = 0;
  for (const x of train) { const error = predict(x) - target(x); gw += 2 * error * x / train.length; gb += 2 * error / train.length; }
  state.velocityWeight = 0.8 * state.velocityWeight + gw;
  state.velocityBias = 0.8 * state.velocityBias + gb;
  state.weight -= 0.015 * state.velocityWeight;
  state.bias -= 0.015 * state.velocityBias;
  state.step++;
}
if (!Object.values(state).every(value => Number.isFinite(value))) throw new Error('nonfinite optimizer state');
writeFileSync(output + '.tmp', JSON.stringify(state) + '\n'); renameSync(output + '.tmp', output);
process.stdout.write(JSON.stringify({ resumedAt: state.step - count, step: state.step, heldoutMseBefore: before,
  heldoutMseAfter: mse([-1.75, -0.75, 0.25, 1.25]) }));
