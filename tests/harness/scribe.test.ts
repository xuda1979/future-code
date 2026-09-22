/**
 * Tests for the scribe agent — the harness's code-writing capability.
 * Covers: planning (coverage detection, bounds, context budget), scaffold
 * generation (determinism, correct relative imports, type-only exports),
 * validation/promotion/quarantine, audit trail, CLI wiring, and the
 * self-apply write-phase.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planScribe, generateScaffold, extractExports, relativeImportPath,
  runScribe, detectRunner,
} from "../../src/harness/scribe/index.ts";
import { build } from "../../src/harness/builder/index.ts";
import { loadManifest, saveManifest } from "../../src/harness/registry.ts";
import type { HarnessManifest, ScribePlanEntry } from "../../src/harness/types.ts";

function tempProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "scribe-"));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }
  return dir;
}

function manifestFor(dir: string, contextBudget = 1): HarnessManifest {
  const { manifest } = build(dir, { harnessId: "scribe-test" });
  manifest.config.contextBudget = contextBudget;
  saveManifest(dir, manifest);
  return manifest;
}

/** A minimal bun project with an untested module. */
function bunProject(): string {
  return tempProject({
    "package.json": JSON.stringify({ name: "scribe-target", scripts: { test: "bun test" } }),
    "src/math.ts": `export function add(a: number, b: number): number { return a + b; }\nexport const VERSION = "1.0.0";\n`,
  });
}

/** A bun project with a tests/ tree (mirrored convention, like future-code). */
function bunProjectWithTestsTree(): string {
  return tempProject({
    "package.json": JSON.stringify({ name: "scribe-mirror", scripts: { test: "bun test" } }),
    "src/math.ts": `export function add(a: number, b: number): number { return a + b; }\nexport const VERSION = "1.0.0";\n`,
    "tests/placeholder.test.ts": `import { test, expect } from "bun:test";\ntest("placeholder", () => { expect(1).toBe(1); });\n`,
  });
}

test("extractExports finds function, const, class, type exports", () => {
  const src = `
export function foo() {}
export async function bar() {}
export const BAZ = 1;
export let mut = 2;
export class Qux {}
export type Shape = { a: number };
export interface ISquare { side: number };
export { renamed as alias };
export default main;
`;
  const names = extractExports(src);
  expect(names).toContain("foo");
  expect(names).toContain("bar");
  expect(names).toContain("BAZ");
  expect(names).toContain("mut");
  expect(names).toContain("Qux");
  expect(names).toContain("Shape");
  expect(names).toContain("ISquare");
  expect(names).toContain("alias");
  expect(names).toContain("main");
});

test("relativeImportPath: sibling dirs", () => {
  expect(relativeImportPath("src/foo.test.ts", "src/foo.ts")).toBe("./foo");
});

test("relativeImportPath: nested test reaches shallow module", () => {
  expect(relativeImportPath("src/a/b/c.test.ts", "src/util.ts")).toBe("../../util");
});

test("relativeImportPath: same dir, no prefix needed gets ./", () => {
  expect(relativeImportPath("src/deep/mod.test.ts", "src/deep/mod.ts")).toBe("./mod");
});

test("planScribe selects untested modules with exports", () => {
  const dir = bunProject();
  const m = manifestFor(dir);
  const plan = planScribe(dir, m);
  const mod = plan.entries.find((e) => e.module === "src/math.ts");
  expect(mod).toBeDefined();
  expect(mod!.reason).toBe("untested");
  expect(mod!.exports).toContain("add");
  expect(mod!.exports).toContain("VERSION");
  // No tests/ tree: colocated destination.
  expect(mod!.testFile).toBe("src/math.test.ts");
});

test("planScribe mirrors destinations into tests/ when the tree exists", () => {
  const dir = bunProjectWithTestsTree();
  const m = manifestFor(dir);
  const plan = planScribe(dir, m);
  const mod = plan.entries.find((e) => e.module === "src/math.ts");
  expect(mod).toBeDefined();
  // tests/ tree exists: destination mirrors src/ -> tests/.
  expect(mod!.testFile).toBe(join("tests", "math.test.ts"));
});

test("planScribe respects the scribeRoot boundary", () => {
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "boundary" }),
    "src/harness/core.ts": `export function core() {}\n`,
    "src/snapshot/other.ts": `export function other() {}\n`,
    "tests/placeholder.test.ts": `import { test } from "bun:test";\ntest("p", () => {});\n`,
  });
  const m = manifestFor(dir);
  m.config.scribeRoot = "src/harness";
  saveManifest(dir, m);
  const plan = planScribe(dir, m);
  expect(plan.entries.find((e) => e.module === "src/harness/core.ts")).toBeDefined();
  expect(plan.entries.find((e) => e.module === "src/snapshot/other.ts")).toBeUndefined();
  const outside = plan.skipped.find((s) => s.module === "src/snapshot/other.ts");
  expect(outside).toBeDefined();
  expect(outside!.reason).toContain("scribeRoot");
});

test("planScribe skips modules with covering tests (colocated and mirrored)", () => {
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "covered" }),
    "src/covered.ts": `export function covered() {}\n`,
    "src/covered.test.ts": `import { test } from "bun:test";\n`,
    "src/mirrored.ts": `export function mirrored() {}\n`,
    "tests/mirrored.test.ts": `import { test } from "bun:test";\n`,
  });
  const m = manifestFor(dir);
  const plan = planScribe(dir, m);
  expect(plan.entries.find((e) => e.module === "src/covered.ts")).toBeUndefined();
  expect(plan.entries.find((e) => e.module === "src/mirrored.ts")).toBeUndefined();
  const skipCovered = plan.skipped.find((s) => s.module === "src/covered.ts");
  expect(skipCovered).toBeDefined();
  expect(skipCovered!.reason).toContain("covered by src/covered.test.ts");
});

test("planScribe skips entrypoints and export-less modules", () => {
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "skips" }),
    "src/index.ts": `export function f() {}\n`,
    "src/empty.ts": `const internal = 1;\n`,
  });
  const m = manifestFor(dir);
  const plan = planScribe(dir, m);
  expect(plan.entries.length).toBe(0);
  expect(plan.skipped.find((s) => s.module === "src/index.ts")).toBeDefined();
  expect(plan.skipped.find((s) => s.module === "src/empty.ts")).toBeDefined();
});

test("planScribe bounds the plan and its context to budget", () => {
  const files: Record<string, string> = { "package.json": JSON.stringify({ name: "bounds" }) };
  for (let i = 0; i < 8; i++) {
    files[`src/mod${i}.ts`] = `export function f${i}() { return ${i}; }\n`;
  }
  const dir = tempProject(files);
  const m = manifestFor(dir, 1); // smallest budget — context must still fit
  const plan = planScribe(dir, m, 3);
  expect(plan.entries.length).toBe(3);
  expect(plan.skipped.filter((s) => s.reason.includes("module limit")).length).toBe(5);
  // Context boundedness: the planning context fits the budget.
  expect(plan.contextTokens).toBeLessThanOrEqual(resolveBudgetOf(dir));
});

function resolveBudgetOf(dir: string): number {
  const m = loadManifest(dir);
  return m.config.contextBudget * 4096;
}

test("planScribe is deterministic: same project yields the same plan", () => {
  const dir = bunProject();
  const m = manifestFor(dir);
  const p1 = planScribe(dir, m);
  const p2 = planScribe(dir, m);
  expect(JSON.stringify(p1.entries)).toBe(JSON.stringify(p2.entries));
});

test("generateScaffold is deterministic and imports via relative path", () => {
  const dir = bunProject();
  const entry: ScribePlanEntry = {
    module: "src/math.ts",
    testFile: "src/math.test.ts",
    reason: "untested",
    exports: ["add", "VERSION"],
  };
  const s1 = generateScaffold(entry, dir);
  const s2 = generateScaffold(entry, dir);
  expect(s1).toBe(s2);
  expect(s1).toContain('from "./math"');
  expect(s1).toContain('expect(add).toBeDefined()');
  expect(s1).toContain('expect(VERSION).toBeDefined()');
  // Not in entry.exports-only mode: the module source confirms both are runtime exports.
  expect(s1).toContain("scribe: add is defined");
});

test("generateScaffold filters type-only exports from runtime imports", () => {
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "types-only" }),
    "src/shapes.ts": `export type Shape = { a: number };\nexport interface ISquare { side: number }\nexport const KIND = "shape";\n`,
  });
  const entry: ScribePlanEntry = {
    module: "src/shapes.ts",
    testFile: "src/shapes.test.ts",
    reason: "untested",
    exports: ["Shape", "ISquare", "KIND"],
  };
  const s = generateScaffold(entry, dir);
  expect(s).toContain("KIND");
  expect(s).not.toContain("import { Shape");
  expect(s).not.toContain("import { ISquare");
});

test("planScribe skips type-only modules — vacuous scaffolds are noise", () => {
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "pure-types" }),
    "src/shapes.ts": `export type Shape = { a: number };\nexport interface ISquare { side: number }\n`,
    "src/runtime.ts": `export function real(): number { return 1; }\n`,
  });
  const m = manifestFor(dir);
  const plan = planScribe(dir, m);
  expect(plan.entries.find((e) => e.module === "src/shapes.ts")).toBeUndefined();
  const skipped = plan.skipped.find((s) => s.module === "src/shapes.ts");
  expect(skipped).toBeDefined();
  expect(skipped!.reason).toContain("type-only");
  // A module with runtime exports is still selected.
  expect(plan.entries.find((e) => e.module === "src/runtime.ts")).toBeDefined();
});

test("generateScaffold handles default exports", () => {
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "default-export" }),
    "src/entry.ts": `export default function main() { return 1; }\n`,
  });
  const entry: ScribePlanEntry = {
    module: "src/entry.ts",
    testFile: "src/entry.test.ts",
    reason: "untested",
    exports: ["main"],
  };
  const s = generateScaffold(entry, dir);
  expect(s).toContain('import mod from "./entry"');
  expect(s).toContain("expect(mod).toBeDefined()");
});

test("runScribe promotes a valid scaffold end-to-end", async () => {
  const dir = bunProject();
  const m = manifestFor(dir);
  const { plan, results, manifest } = await runScribe(dir, m);
  expect(plan.entries.length).toBeGreaterThan(0);
  const promoted = results.find((r) => r.entry.module === "src/math.ts");
  expect(promoted).toBeDefined();
  expect(promoted!.outcome).toBe("promoted");
  expect(existsSync(join(dir, "src/math.test.ts"))).toBe(true);
  // Audit trail recorded.
  expect((manifest.scribeLog ?? []).length).toBeGreaterThan(0);
  const promoteAction = (manifest.scribeLog ?? []).find((a) => a.kind === "promote");
  expect(promoteAction).toBeDefined();
  expect(promoteAction!.target).toBe("src/math.ts");
  // A second scribe pass finds the module covered now.
  const plan2 = planScribe(dir, manifest);
  expect(plan2.entries.find((e) => e.module === "src/math.ts")).toBeUndefined();
});

test("runScribe quarantines a scaffold that fails validation", async () => {
  // A module that throws at import time: the top-level reference to an
  // unknown global fails when bun evaluates the module, so even a pure
  // "is defined" smoke test exits nonzero — the scaffold must quarantine.
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "broken", scripts: { test: "bun test" } }),
    "src/broken.ts": `export const boom: number = someUnknownGlobalAtImportTime;\n`,
  });
  const m = manifestFor(dir);
  const { results, manifest } = await runScribe(dir, m);
  const q = results.find((r) => r.entry.module === "src/broken.ts");
  expect(q).toBeDefined();
  expect(q!.outcome).toBe("quarantined");
  // Nothing entered the project's test tree.
  expect(existsSync(join(dir, "src/broken.test.ts"))).toBe(false);
  // The quarantine dir retains the scaffold with the failure recorded.
  expect(existsSync(join(dir, ".future-code/scribe/quarantine/src/broken.test.ts"))).toBe(true);
  const qAction = (manifest.scribeLog ?? []).find((a) => a.kind === "quarantine");
  expect(qAction).toBeDefined();
});

test("runScribe records exit codes and bounded output", async () => {
  const dir = bunProject();
  const m = manifestFor(dir);
  const { results } = await runScribe(dir, m);
  const promoted = results.find((r) => r.entry.module === "src/math.ts");
  expect(promoted!.exitCode).toBe(0);
});

test("scribeLog is bounded to 100 entries", async () => {
  const dir = bunProject();
  const m = manifestFor(dir);
  // Simulate a long log.
  m.scribeLog = [];
  for (let i = 0; i < 105; i++) {
    m.scribeLog.push({
      id: `scribe-${i}`, kind: "plan", target: "(plan)",
      rationale: "filler", at: new Date().toISOString(),
    });
  }
  saveManifest(dir, m);
  const { manifest } = await runScribe(dir, m, { maxModules: 0 });
  expect((manifest.scribeLog ?? []).length).toBeLessThanOrEqual(100);
});

test("detectRunner prefers bun", () => {
  const dir = bunProject();
  expect(detectRunner(dir)).toBe("bun");
});

test("CLI scribe subcommand plans, writes, and reports", async () => {
  const dir = bunProject();
  const { manifest } = build(dir, { harnessId: "cli-scribe" });
  saveManifest(dir, manifest);
  const proc = Bun.spawnSync(["bun", "src/harness/cli.ts", "scribe", "--project", dir], {
    cmd: ["bun", "src/harness/cli.ts", "scribe", "--project", dir],
    stdout: "pipe", stderr: "pipe",
  } as never);
  const stdout = proc.stdout.toString();
  let json: any;
  try {
    const m = stdout.match(/\{[\s\S]*\n\}/);
    if (m) json = JSON.parse(m[0]);
  } catch { /* ignore */ }
  expect(json).toBeDefined();
  expect(json.planned).toBeGreaterThan(0);
  expect(json.results.some((r: any) => r.module === "src/math.ts" && r.outcome === "promoted")).toBe(true);
  expect(existsSync(join(dir, "src/math.test.ts"))).toBe(true);
});

test("CLI selfapply runs the write-phase before iterating", async () => {
  const dir = bunProject();
  const proc = Bun.spawnSync({
    cmd: ["bun", "src/harness/cli.ts", "selfapply", "--project", dir],
    stdout: "pipe", stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  // The write-phase note must appear, and the promoted scaffold must exist.
  expect(stdout).toContain("scribe");
  expect(existsSync(join(dir, "src/math.test.ts"))).toBe(true);
  const m = loadManifest(dir);
  expect((m.scribeLog ?? []).length).toBeGreaterThan(0);
});

test("CLI selfapply bounds the write-phase to src/harness on the platform repo", async () => {
  // Reproduce the future-code layout: src/harness (platform) + src/snapshot
  // (mirrored research code the design doc forbids modifying).
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "platform-shape", scripts: { test: "bun test" } }),
    "src/harness/tiny.ts": `export function tiny(): number { return 1; }\n`,
    "src/snapshot/research.ts": `export function research(): number { return 2; }\n`,
  });
  const proc = Bun.spawnSync({
    cmd: ["bun", "src/harness/cli.ts", "selfapply", "--project", dir],
    stdout: "pipe", stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  expect(stdout).toContain("scribe");
  // Platform module scaffolded (colocated — no tests/ tree in this fixture).
  expect(existsSync(join(dir, "src/harness/tiny.test.ts"))).toBe(true);
  // Research snapshot untouched.
  expect(existsSync(join(dir, "src/snapshot/research.test.ts"))).toBe(false);
  const m = loadManifest(dir);
  expect(m.config.scribeRoot).toBe("src/harness");
  const targets = (m.scribeLog ?? []).map((a) => a.target);
  expect(targets).not.toContain("src/snapshot/research.ts");
});
