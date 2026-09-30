import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  isUsableUsageAnchor,
  sumUsage,
} from "../../src/utils/tokenAnchor.ts";

const zeroUsage = {
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
};

test("sumUsage sums all usage fields", () => {
  assert.equal(
    sumUsage({ ...zeroUsage, input_tokens: 100, output_tokens: 5 }),
    105,
  );
  assert.equal(
    sumUsage({
      ...zeroUsage,
      input_tokens: 10,
      cache_read_input_tokens: 90,
    }),
    100,
  );
});

test("zero-total usage is not a usable estimation anchor", () => {
  // Regression: providers/proxies that never report usage emit all-zero
  // usage on every response. Anchoring on it made context look ~0 tokens,
  // autocompact never fired, and the session silently grew past the model
  // window — surfacing as recurring empty end_turn responses.
  assert.equal(isUsableUsageAnchor(zeroUsage), false);
  assert.equal(isUsableUsageAnchor(undefined), false);
});

test("positive-total usage is a usable estimation anchor", () => {
  assert.equal(
    isUsableUsageAnchor({ ...zeroUsage, input_tokens: 1 }),
    true,
  );
  assert.equal(
    isUsableUsageAnchor({ ...zeroUsage, cache_read_input_tokens: 12 }),
    true,
  );
  assert.equal(
    isUsableUsageAnchor({ ...zeroUsage, output_tokens: 3 }),
    true,
  );
});

// getTokenUsage lives in src/utils/tokens.ts, which value-imports the SDK
// dependency chain (services/tokenEstimation.js) and so cannot be loaded
// under node --experimental-strip-types. Per the repo's two-runtime rule
// (see tests/commands/list-agents.test.ts), assert the wiring by source.
test("getTokenUsage gates on isUsableUsageAnchor (source assertion)", () => {
  const tokensPath = fileURLToPath(
    new URL("../../src/utils/tokens.ts", import.meta.url),
  );
  const source = readFileSync(tokensPath, "utf8");
  assert.match(
    source,
    /import \{ isUsableUsageAnchor \} from ['"]\.\/tokenAnchor\.js['"]/,
    "tokens.ts must import the anchor validator",
  );
  // The gate must sit in the assistant-usage predicate, not merely be imported.
  const gatePattern =
    /message\.message\.model !== SYNTHETIC_MODEL\s*&&\s*\n\s*\/\/[\s\S]*?isUsableUsageAnchor\(message\.message\.usage\)/;
  assert.match(
    source,
    gatePattern,
    "getTokenUsage must reject zero-total usage before returning it as an anchor",
  );
});
