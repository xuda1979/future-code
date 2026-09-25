// Frozen, deterministic acceptance code; this is an OFFLINE-CAPABLE fixture,
// not proof that an arbitrary feature or repository has been correctly built.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
assert.equal(readFileSync("examples/swarm/output/answer.txt", "utf8").trim(), "42");
console.log("demo behavior verified");
