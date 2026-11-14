/**
 * Regression test: the default commit trailer must be the fixed brand trailer
 * "Future-Code V1.0 <exutechnology@gmail.com>" and must never fall back to the
 * per-model "<name> <noreply@future.com>" form. The trailer is a compile-time
 * constant in getAttributionTexts(), so asserting on the source contract is
 * deterministic regardless of local settings overrides.
 * Run with: node --experimental-strip-types --test tests/commands/attribution-trailer.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../src/utils/attribution.ts"),
  "utf8",
);

test("default commit trailer is the fixed Future-Code brand trailer", () => {
  assert.match(
    source,
    /const defaultCommit = 'Co-Authored-By: Future-Code V1\.0 <exutechnology@gmail\.com>'/,
  );
});

test("attribution source no longer ships the per-model noreply address", () => {
  assert.ok(!source.includes("noreply@future.com"));
});
