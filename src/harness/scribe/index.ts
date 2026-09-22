/**
 * Scribe agent — the harness's code-writing capability.
 *
 * Until now the harness could only *run* pre-defined gates; the scribe
 * extends it to *write* code: it scans the project for source modules
 * that lack tests, drafts a deterministic scaffold test for each
 * (import + smoke assertion per export), validates the draft through the
 * project's real test runner, and either promotes it into the project's
 * test tree or quarantines it with the failure output attached.
 *
 * Design rules, in priority order:
 *  1. Deterministic: no LLM, no network. The scaffold's shape depends
 *     only on the module's exports, so the same module always yields the
 *     same test.
 *  2. Nothing broken ships: scaffolds validate in an isolated staging
 *     area (a copy of the source tree, outside the project's own test
 *     run) BEFORE any file enters the project; failures quarantine,
 *     never promote.
 *  3. Bounded context: the planning context (module list + export
 *     signatures) is truncated through the same context-budget enforcer
 *     as every other agent.
 *  4. Full audit: every action lands in manifest.scribeLog, bounded the
 *     same way as improvementHistory.
 */
import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { join, relative, dirname, basename } from "node:path";
import { spawn } from "node:child_process";
import type { HarnessManifest, ScribePlan, ScribePlanEntry, ScribeResult, ScribeAction } from "../types.ts";
import { estimateTokens, resolveBudget, truncateToBudget } from "../context.ts";

const SCRIBE_LOG_LIMIT = 100;

/** After this many quarantined scaffolds a module is skipped in planning. */
const QUARANTINE_LIMIT = 2;

/** Count how many times a module's scaffold was quarantined, from the audit trail. */
function countQuarantines(manifest: HarnessManifest, module: string): number {
  return (manifest.scribeLog ?? []).filter((a) => a.kind === "quarantine" && a.target === module).length;
}

/** Directories the scribe never scans or writes into. */
const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".future-code",
  "coverage", "vendor", "target", ".venv", "__pycache__",
]);

/** Test files are these patterns; a module whose tests exist is covered. */
const TEST_SUFFIXES = [".test.ts", ".test.tsx", ".test.js", ".spec.ts", ".spec.js", "_test.ts", "_test.go", ".test.py"];

/** Source suffixes the scribe can scaffold for. */
const SOURCE_SUFFIXES = [".ts", ".tsx", ".js"];

/** Files whose names mark them as tests, helpers, or entrypoints (never scaffolded). */
const NON_TARGET_NAMES = new Set(["index.ts", "main.ts", "cli.ts", "mod.ts"]);

/**
 * Recursively list files under `dir`, skipping IGNORED_DIRS. Depth-limited
 * so a pathological tree cannot blow up the scan.
 */
function listFiles(dir: string, maxDepth = 8, depth = 0): string[] {
  let out: string[] = [];
  if (depth > maxDepth) return out;
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory: () => boolean }>;
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".") continue;
    if (IGNORED_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out = out.concat(listFiles(full, maxDepth, depth + 1));
    } else {
      out.push(full);
    }
  }
  return out;
}

/** Is this path a test file? */
function isTestFile(path: string): boolean {
  return TEST_SUFFIXES.some((s) => path.endsWith(s));
}

/** Is this path a scaffoldable source module? */
function isSourceModule(path: string): boolean {
  return SOURCE_SUFFIXES.some((s) => path.endsWith(s));
}

/** Determine the test file path for a module: colocated .test.ts convention. */
function testPathFor(module: string): string {
  const base = module.replace(/\.(ts|tsx|js)$/, "");
  return `${base}.test.ts`;
}

/**
 * Compute the import specifier the scaffold test must use to reach the
 * module: relative from the test file's directory to the module, always
 * with an explicit "./" or "../" prefix.
 */
export function relativeImportPath(testFile: string, module: string): string {
  const testDir = dirname(testFile);
  let rel = relative(testDir, module.replace(/\.(ts|tsx|js)$/, ""));
  // Windows path separators normalize to "/" for import specifiers.
  rel = rel.split("\\").join("/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

/** Extract exported symbol names from a module's source (best-effort, regex). */
export function extractExports(src: string): string[] {
  const names = new Set<string>();
  for (const m of src.matchAll(/export\s+(?:abstract\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const piece of m[1].split(",")) {
      const name = piece.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  for (const m of src.matchAll(/export\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+default\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return [...names];
}

/** Type-only exports detected in a module's source. */
function typeOnlyExports(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/export\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return names;
}

/**
 * Destination convention: where the scribe writes a scaffold for `module`.
 * Mirrors the project's own layout — when a `tests/` tree exists, tests go
 * to `tests/<module>.test.ts` (with any `src/` prefix stripped); otherwise
 * colocated next to the module. This is what makes the run-phase measure
 * what the write-phase wrote: the promoted file lands where the project's
 * test runner already looks.
 */
export function destinationFor(projectRoot: string, module: string): string {
  const hasTestsTree = existsSync(join(projectRoot, "tests"));
  if (hasTestsTree) {
    const noSrc = module.replace(/^src\//, "");
    return join("tests", testPathFor(noSrc));
  }
  return testPathFor(module);
}

/** Look up whether a test exists covering the module (colocated or mirrored tests/ tree). */
function findCoveringTest(root: string, module: string, allFiles: string[]): string | undefined {
  const rel = relative(root, module);
  const candidates = new Set<string>();
  candidates.add(testPathFor(rel));
  const noSrc = rel.replace(/^src\//, "");
  candidates.add(join("tests", testPathFor(noSrc)));
  candidates.add(destinationFor(root, rel));
  for (const f of allFiles) {
    const fRel = relative(root, f);
    if (candidates.has(fRel)) return fRel;
  }
  return undefined;
}

/**
 * Plan what the scribe should write: every scaffoldable source module
 * without a covering test, with its exports, bounded by the context budget.
 * The scan is bounded by config.scribeRoot when set (the harness scope) —
 * the write-phase never leaves its boundary.
 */
export function planScribe(projectRoot: string, manifest: HarnessManifest, maxModules = 5): ScribePlan {
  const scribeRoot = manifest.config.scribeRoot?.trim();
  const files = listFiles(projectRoot).filter((f) => !relative(projectRoot, f).startsWith(".future-code"));
  const sourceModules = files.filter((f) => isSourceModule(f) && !isTestFile(f));

  const entries: ScribePlanEntry[] = [];
  const skipped: { module: string; reason: string }[] = [];

  for (const mod of sourceModules) {
    const rel = relative(projectRoot, mod);
    // scribeRoot boundary: unscoped modules are never scaffolded and never
    // receive scaffold files.
    if (scribeRoot && !rel.startsWith(`${scribeRoot}/`)) {
      skipped.push({ module: rel, reason: "outside scribeRoot boundary" });
      continue;
    }
    // Never scaffold for entrypoints/helpers: their side effects make
    // deterministic smoke tests meaningless or harmful.
    if (NON_TARGET_NAMES.has(basename(rel))) {
      skipped.push({ module: rel, reason: "entrypoint/helper (non-target)" });
      continue;
    }
    let src = "";
    try {
      src = readFileSync(mod, "utf8");
    } catch {
      skipped.push({ module: rel, reason: "unreadable" });
      continue;
    }
    const exports = extractExports(src);
    if (exports.length === 0) {
      skipped.push({ module: rel, reason: "no exports" });
      continue;
    }
    // A module whose only exports are types/interfaces yields a vacuous
    // scaffold ("true === true") — noise, not coverage. Skip it.
    const typeOnly = typeOnlyExports(src);
    const runtimeExports = exports.filter((n) => !typeOnly.has(n));
    const hasDefault = /export\s+default\s+/.test(src);
    if (runtimeExports.length === 0 && !hasDefault) {
      skipped.push({ module: rel, reason: "type-only exports (vacuous scaffold)" });
      continue;
    }
    const covering = findCoveringTest(projectRoot, mod, files);
    if (covering) {
      skipped.push({ module: rel, reason: `covered by ${covering}` });
      continue;
    }
    // Failure memory: a module whose scaffolds quarantined QURARANTINE_LIMIT
    // times keeps failing validation for a structural reason (broken import,
    // missing dependency). Re-drafting it every pass wastes work without
    // progress — skip it with the failure count recorded, mirroring the
    // improver's quarantine-repeat-failure discipline for gates.
    const quarantineCount = countQuarantines(manifest, rel);
    if (quarantineCount >= QUARANTINE_LIMIT) {
      skipped.push({
        module: rel,
        reason: `repeat-quarantine (failed validation ${quarantineCount}x; skipping until the module is fixed)`,
      });
      continue;
    }
    entries.push({ module: rel, testFile: destinationFor(projectRoot, rel), reason: "untested", exports });
  }

  // Bound the plan: priority = most exports first (most testable surface).
  const ranked = entries.sort((a, b) => b.exports.length - a.exports.length);
  const selected = ranked.slice(0, maxModules);
  for (const e of ranked.slice(maxModules)) {
    skipped.push({ module: e.module, reason: "plan bounded (module limit)" });
  }

  const contextRaw = JSON.stringify(
    { project: basename(projectRoot), scribeRoot: scribeRoot ?? null, selected, skippedCount: skipped.length },
    null, 1,
  );
  const budget = resolveBudget(manifest);
  const context = truncateToBudget(contextRaw, budget);
  return { entries: selected, skipped, context, contextTokens: estimateTokens(context) };
}

/**
 * Parse a function declaration's parameter list (source text after the
 * name, up to the matching close paren) and return its arity, counting a
 * trailing rest param. Returns null when the declaration is a function
 * expression assigned to a const whose parameter text cannot be located.
 */
export function parseArity(src: string, name: string): number | null {
  // Named function declarations and class methods.
  let m = new RegExp(`(?:function\\s+|method\\s+)${name}\\s*\\(([^)]*)\\)`).exec(src);
  if (!m) {
    // Arrow/function expression assigned to a const/let/var of that name.
    // An optional return-type annotation may sit between ) and =>.
    m = new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?\\(([^)]*)\\)\\s*(?::[^=]*)?=>`).exec(src)
      ?? new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*(?:async\\s+)?function\\s*\\(([^)]*)\\)`).exec(src);
  }
  if (!m) return null;
  const params = m[1].trim();
  if (!params) return 0;
  // Destructured/object params carry no reliable per-name arity signal —
  // count top-level commas only (parens/braces/brackets balanced).
  let depth = 0;
  let count = 1;
  for (const ch of params) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === "," && depth === 0) count++;
  }
  return count;
}

/**
 * Extract literal initializers: exported consts initialized to a string,
 * number, or boolean literal. These get typeof-assertions in scaffolds —
 * a real API-surface signal (type drift caught) with zero execution risk.
 */
export function literalExports(src: string): Map<string, "string" | "number" | "boolean"> {
  const out = new Map<string, "string" | "number" | "boolean">();
  for (const m of src.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:"([^"]*)"|'([^']*)'|(\d+(?:\.\d+)?)|(true|false))\s*[;\n]/g)) {
    const name = m[1];
    if (m[2] !== undefined || m[3] !== undefined) out.set(name, "string");
    else if (m[4] !== undefined) out.set(name, "number");
    else if (m[5] !== undefined) out.set(name, "boolean");
  }
  return out;
}

/**
 * Generate the scaffold test source for one plan entry. Deterministic:
 * same module + exports always yield the same test.
 */
export function generateScaffold(entry: ScribePlanEntry, projectRoot: string): string {
  const importSpec = relativeImportPath(entry.testFile, entry.module);
  let src = "";
  try {
    src = readFileSync(join(projectRoot, entry.module), "utf8");
  } catch { /* unreadable — fall back to all exports */ }
  const typeOnly = typeOnlyExports(src);
  const runtimeExports = entry.exports.filter((n) => !typeOnly.has(n));
  const hasDefault = /export\s+default\s+/.test(src);

  const lines: string[] = [];
  lines.push("/**");
  lines.push(` * Scribe-generated scaffold test for ${entry.module}.`);
  lines.push(" * Deterministically drafted by the future-code harness scribe to close a");
  lines.push(" * coverage gap; validated before promotion. Replace the smoke assertions");
  lines.push(" * with real behavior tests as the module matures.");
  lines.push(" */");
  lines.push('import { test, expect } from "bun:test";');
  if (runtimeExports.length) lines.push(`import { ${runtimeExports.join(", ")} } from "${importSpec}";`);
  if (hasDefault) lines.push(`import mod from "${importSpec}";`);
  lines.push("");
  // Type-only modules never reach here — planScribe skips them (a vacuous
  // "true === true" scaffold is noise, not coverage).
  const literals = literalExports(src);
  const funcLike = new Set<string>();
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) funcLike.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)\s*(?::[^=]*)?=>|function\b)/g)) funcLike.add(m[1]);
  for (const name of runtimeExports) {
    const arity = funcLike.has(name) ? parseArity(src, name) : null;
    const lit = literals.get(name);
    lines.push(`test("scribe: ${name} is defined", () => {`);
    lines.push(`  expect(${name}).toBeDefined();`);
    if (arity !== null && arity > 0) {
      lines.push(`  // Arity pinned from the module source — catches signature drift.`);
      lines.push(`  expect(typeof ${name} === "function" && ${name}.length).toBe(${arity});`);
    }
    if (lit) {
      lines.push(`  // Literal type pinned from the initializer — catches type drift.`);
      lines.push(`  expect(typeof ${name}).toBe("${lit}");`);
    }
    lines.push("});");
    lines.push("");
  }
  if (hasDefault) {
    lines.push('test("scribe: default export is defined", () => {');
    lines.push("  expect(mod).toBeDefined();");
    lines.push("});");
    lines.push("");
  }
  return lines.join("\n");
}

/** Run a command with a timeout; resolve with output/exitCode. */
function runCommand(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  args: string[],
): Promise<{ output: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let out = "";
    let timedOut = false;
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ output: out, exitCode: code ?? -1, timedOut });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ output: out + "\nspawn error", exitCode: -1, timedOut });
    });
  });
}

/** Detect the project's test runner for validation. */
export function detectRunner(projectRoot: string): "bun" | "node" | "unknown" {
  try {
    const pkgRaw = readFileSync(join(projectRoot, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw) as { devDependencies?: Record<string, string>; scripts?: Record<string, string> };
    if (pkg.devDependencies?.["bun-types"] || pkg.devDependencies?.["@types/bun"] || pkg.scripts?.["test"]?.includes("bun")) return "bun";
  } catch { /* no package.json — fall through */ }
  // Bun is the platform runtime; prefer it when nothing contradicts.
  return "bun";
}

/** Validation-copy helper: copy resolution-critical project files into a staging dir. */
function buildValidationCopy(projectRoot: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const rel of ["package.json", "tsconfig.json", "bunfig.toml"]) {
    const p = join(projectRoot, rel);
    if (existsSync(p) && statSync(p).isFile()) cpSync(p, join(dest, rel));
  }
  for (const relDir of ["src", "tests", "lib"]) {
    const p = join(projectRoot, relDir);
    if (existsSync(p) && statSync(p).isDirectory()) {
      cpSync(p, join(dest, relDir), { recursive: true });
    }
  }
}

/** Stable action id from a counter carried on the manifest's scribeLog. */
function nextScribeId(manifest: HarnessManifest, kind: string, target: string): string {
  const n = (manifest.scribeLog?.length ?? 0) + 1;
  const slug = target.replace(/[^\w.-]/g, "_").slice(0, 40);
  return `scribe-${String(n).padStart(3, "0")}-${kind}-${slug}`;
}

/**
 * Scribe one plan entry: generate the scaffold, validate it in an
 * isolated staging area, then promote (on pass) or quarantine (on fail).
 */
export async function scribeEntry(
  projectRoot: string,
  manifest: HarnessManifest,
  entry: ScribePlanEntry,
): Promise<{ result: ScribeResult; action: ScribeAction }> {
  const scribeDir = join(projectRoot, ".future-code", "scribe");
  const stagingRoot = join(scribeDir, "staging");
  const quarantineRoot = join(scribeDir, "quarantine");
  mkdirSync(stagingRoot, { recursive: true });
  mkdirSync(quarantineRoot, { recursive: true });

  // 1. Generate the scaffold.
  const scaffold = generateScaffold(entry, projectRoot);
  const stagedTestPath = join(stagingRoot, entry.testFile);
  mkdirSync(dirname(stagedTestPath), { recursive: true });
  writeFileSync(stagedTestPath, scaffold, "utf8");

  // 2. Build the validation copy and place the scaffold at its real path.
  const validationCopy = join(stagingRoot, "__validation__");
  rmSync(validationCopy, { recursive: true, force: true });
  buildValidationCopy(projectRoot, validationCopy);
  const inValidation = join(validationCopy, entry.testFile);
  mkdirSync(dirname(inValidation), { recursive: true });
  cpSync(stagedTestPath, inValidation);

  // 3. Run the project's real test runner against just the scaffold file.
  const runner = detectRunner(projectRoot);
  let res: { output: string; exitCode: number; timedOut: boolean };
  if (runner === "bun") {
    res = await runCommand("bun", validationCopy, 60_000, ["test", entry.testFile]);
  } else if (runner === "node") {
    res = await runCommand("node", validationCopy, 60_000, ["--test", entry.testFile]);
  } else {
    rmSync(validationCopy, { recursive: true, force: true });
    const qPath = join(quarantineRoot, entry.testFile);
    mkdirSync(dirname(qPath), { recursive: true });
    cpSync(stagedTestPath, qPath);
    rmSync(stagedTestPath, { force: true });
    return {
      result: {
        entry, outcome: "quarantined",
        file: relative(projectRoot, qPath),
        output: "no supported test runner detected; cannot validate",
        exitCode: -1,
      },
      action: {
        id: nextScribeId(manifest, "quarantine", entry.module),
        kind: "quarantine", target: entry.module, file: relative(projectRoot, qPath),
        rationale: "no supported test runner; scaffold quarantined unvalidated",
        at: new Date().toISOString(),
      },
    };
  }

  rmSync(validationCopy, { recursive: true, force: true });
  const outputBounded = truncateToBudget(res.output, Math.min(resolveBudget(manifest), 2048));

  // 4. Promote or quarantine.
  if (res.exitCode === 0 && !res.timedOut) {
    const dest = join(projectRoot, entry.testFile);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(stagedTestPath, dest);
    rmSync(stagedTestPath, { force: true });
    return {
      result: { entry, outcome: "promoted", file: relative(projectRoot, dest), output: outputBounded, exitCode: 0 },
      action: {
        id: nextScribeId(manifest, "promote", entry.module),
        kind: "promote", target: entry.module, file: relative(projectRoot, dest),
        rationale: `scaffold validated (exit 0) and promoted to ${relative(projectRoot, dest)}`,
        at: new Date().toISOString(),
      },
    };
  }

  const qPath = join(quarantineRoot, entry.testFile);
  mkdirSync(dirname(qPath), { recursive: true });
  cpSync(stagedTestPath, qPath);
  rmSync(stagedTestPath, { force: true });
  return {
    result: {
      entry, outcome: "quarantined",
      file: relative(projectRoot, qPath),
      output: outputBounded, exitCode: res.exitCode, timedOut: res.timedOut,
    },
    action: {
      id: nextScribeId(manifest, "quarantine", entry.module),
      kind: "quarantine", target: entry.module, file: relative(projectRoot, qPath),
      rationale: `scaffold failed validation (exit ${res.exitCode}${res.timedOut ? ", timed out" : ""}); quarantined with output`,
      at: new Date().toISOString(),
    },
  };
}

/** Full scribe pass: plan, write+validate each entry, record everything. */
export async function runScribe(
  projectRoot: string,
  manifest: HarnessManifest,
  opts: { maxModules?: number } = {},
): Promise<{ plan: ScribePlan; results: ScribeResult[]; manifest: HarnessManifest }> {
  const plan = planScribe(projectRoot, manifest, opts.maxModules ?? 5);
  const results: ScribeResult[] = [];
  for (const entry of plan.entries) {
    const { result, action } = await scribeEntry(projectRoot, manifest, entry);
    results.push(result);
    manifest.scribeLog = manifest.scribeLog ?? [];
    manifest.scribeLog.push(action);
  }
  // Upgrade pass: scribe-authored scaffolds that predate the enrichment
  // (arity pins / literal-type pins) are regenerated and re-validated in
  // place. The scribe improves its own prior work — same module, same
  // determinism, stronger assertions — without touching human-written tests.
  const upgraded = await upgradePriorScaffolds(projectRoot, manifest);
  results.push(...upgraded.results);
  manifest.scribeLog = manifest.scribeLog ?? [];
  for (const a of upgraded.actions) manifest.scribeLog.push(a);
  manifest.scribeLog = manifest.scribeLog ?? [];
  manifest.scribeLog.push({
    id: nextScribeId(manifest, "plan", "(plan)"),
    kind: "plan",
    target: "(plan)",
    rationale: `planned ${plan.entries.length} module(s); skipped ${plan.skipped.length}; upgraded ${upgraded.results.length} prior scaffold(s) (context ${plan.contextTokens} tokens)`,
    at: new Date().toISOString(),
  });
  if (manifest.scribeLog.length > SCRIBE_LOG_LIMIT) manifest.scribeLog = manifest.scribeLog.slice(-SCRIBE_LOG_LIMIT);
  return { plan, results, manifest };
}

/**
 * Upgrade pass — regenerate the scribe's own prior scaffolds when they
 * lack the enrichment the current generator would produce. Only files
 * carrying the scribe's signature header are eligible: human tests are
 * never rewritten.
 */
async function upgradePriorScaffolds(
  projectRoot: string,
  manifest: HarnessManifest,
): Promise<{ results: ScribeResult[]; actions: ScribeAction[] }> {
  const results: ScribeResult[] = [];
  const actions: ScribeAction[] = [];
  const scribeRoot = manifest.config.scribeRoot?.trim();
  const files = listFiles(projectRoot).filter((f) => !relative(projectRoot, f).startsWith(".future-code"));
  for (const f of files) {
    if (!isTestFile(f)) continue;
    const rel = relative(projectRoot, f);
    let body = "";
    try {
      body = readFileSync(f, "utf8");
    } catch { continue; }
    if (!body.includes("Scribe-generated scaffold test")) continue;
    if (body.includes("// Arity pinned from the module source")) continue; // already enriched
    // Recover the module this scaffold targets from its header comment.
    // The path itself contains dots (".ts"), so the delimiter is the
    // period followed by end-of-line, not any period.
    const m = /Scribe-generated scaffold test for (\S+?)\.\s/.exec(body)
      ?? /Scribe-generated scaffold test for (\S+?)\.$/.exec(body);
    if (!m) continue;
    const modRel = m[1];
    // Respect the scribeRoot boundary for upgrades too.
    if (scribeRoot && !modRel.startsWith(`${scribeRoot}/`)) continue;
    // Only upgrade when the module still exists.
    if (!existsSync(join(projectRoot, modRel))) continue;
    // Rebuild the entry from the module's current exports.
    let src = "";
    try {
      src = readFileSync(join(projectRoot, modRel), "utf8");
    } catch { continue; }
    const exports = extractExports(src);
    if (exports.length === 0) continue;
    const entry: ScribePlanEntry = {
      module: modRel,
      testFile: rel,
      reason: "untested",
      exports,
    };
    // Regenerate and validate the enriched scaffold.
    const { result, action } = await scribeEntry(projectRoot, manifest, entry);
    if (result.outcome === "promoted") {
      actions.push({
        ...action,
        rationale: `prior scribe scaffold upgraded with arity/literal pins; re-validated (exit 0) at ${result.file}`,
      });
      results.push({ ...result, outcome: "promoted" });
    } else {
      // The enriched scaffold failed validation — the prior scaffold stays
      // (it is still passing); record the failed upgrade without replacing it.
      actions.push({
        ...action,
        kind: "skip",
        rationale: `enriched regeneration failed validation (exit ${result.exitCode}); prior scaffold retained`,
      });
    }
  }
  return { results, actions };
}
