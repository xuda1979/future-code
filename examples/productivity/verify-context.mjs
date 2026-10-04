/** Frozen independent regression for a real Future-Code source task. */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const { inlineReceipt } = await import(pathToFileURL(resolve("src/harness/foundry/swarm/context.ts")));
for (const limit of [-1, 0, 1.5, NaN, Infinity]) assert.throws(() => inlineReceipt("receipt", { value: 1 }, limit), /invalid inline receipt limit/);
assert.equal(inlineReceipt("receipt", { value: 1 }, 512), '{"value":1}');
const clipped = JSON.parse(inlineReceipt("receipt", { log: "x".repeat(10000) }, 512));
assert.equal(clipped.receipt, "receipt"); assert.equal(clipped.truncated, true);
assert.match(clipped.note, /Full output retained/);
