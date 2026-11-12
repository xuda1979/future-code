/**
 * Tests for src/utils/systemResources.ts — memory sensing parsers, budget
 * computation, context line, and OOM recognition/recovery hints.
 *
 * Pure-function fixtures only: no specific hardware, no network, no model
 * calls. Host-touching helpers (getMemoryBudget/getMemoryContextLine) are
 * exercised with invariant assertions only, so they pass on macOS, Linux,
 * and CI runners alike.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cpus } from "node:os";
import {
  parseMacVmStat,
  parseLinuxMemInfo,
  parseCgroupV2,
  parseCgroupV1,
  parseNvidiaSmi,
  parseNpuSmiHbm,
  formatBytes,
  suggestMaxMemoryHeavyJobs,
  getMemoryBudget,
  getMemoryContextLine,
  diagnoseOom,
  buildOomHint,
  getOomHintForOutput,
} from "../../src/utils/systemResources.ts";

const KiB = 1024;
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

/** Run fn with one env var forced (undefined = unset), restoring after. */
function withEnv(key: string, value: string | undefined, fn: () => void) {
  const saved = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

// ── parseMacVmStat ────────────────────────────────────────────────────────

test("parseMacVmStat computes free and available from page counts", () => {
  const text = [
    "Mach Virtual Memory Statistics: (page size of 4096 bytes)",
    "Pages free:                                1000.",
    "Pages speculative:                          200.",
    "Pages purgeable:                             50.",
    "File-backed pages:                          300.",
    "Pages wired down:                           999.",
  ].join("\n");
  const parsed = parseMacVmStat(text, 4096);
  assert.ok(parsed, "expected vm_stat fixture to parse");
  assert.equal(parsed.freeBytes, 1000 * 4096);
  assert.equal(parsed.availableBytes, (1000 + 200 + 50 + 300) * 4096);
});

test("parseMacVmStat falls back to 'Pages occupied by cache' phrasing", () => {
  const text = ['Pages free:                 10.', '"Pages occupied by cache":          20.'].join(
    "\n",
  );
  const parsed = parseMacVmStat(text, 16384);
  assert.ok(parsed);
  assert.equal(parsed.freeBytes, 10 * 16384);
  assert.equal(parsed.availableBytes, (10 + 20) * 16384);
});

test("parseMacVmStat returns null without 'Pages free'", () => {
  assert.equal(parseMacVmStat("Pages wired down: 5.", 4096), null);
});

// ── parseLinuxMemInfo ─────────────────────────────────────────────────────

test("parseLinuxMemInfo prefers MemAvailable", () => {
  const text = [
    "MemTotal:       16384000 kB",
    "MemFree:         1000000 kB",
    "MemAvailable:    8000000 kB",
    "Buffers:          200000 kB",
    "Cached:          3000000 kB",
  ].join("\n");
  const parsed = parseLinuxMemInfo(text);
  assert.ok(parsed);
  assert.equal(parsed.totalBytes, 16384000 * KiB);
  assert.equal(parsed.availableBytes, 8000000 * KiB);
});

test("parseLinuxMemInfo falls back to MemFree+Cached+Buffers", () => {
  const text = [
    "MemTotal:       16384000 kB",
    "MemFree:         1000000 kB",
    "Buffers:          200000 kB",
    "Cached:          3000000 kB",
  ].join("\n");
  const parsed = parseLinuxMemInfo(text);
  assert.ok(parsed);
  assert.equal(parsed.availableBytes, (1000000 + 200000 + 3000000) * KiB);
});

test("parseLinuxMemInfo caps available at total", () => {
  const text = ["MemTotal:         100 kB", "MemAvailable:     500 kB"].join("\n");
  const parsed = parseLinuxMemInfo(text);
  assert.ok(parsed);
  assert.equal(parsed.availableBytes, 100 * KiB);
});

test("parseLinuxMemInfo returns null without MemTotal", () => {
  assert.equal(parseLinuxMemInfo("MemFree: 1 kB"), null);
});

// ── cgroup parsers ────────────────────────────────────────────────────────

test("parseCgroupV2 handles 'max', numeric limits, and missing files", () => {
  assert.deepEqual(parseCgroupV2("max", "123"), { limitBytes: null, currentBytes: 123 });
  assert.deepEqual(parseCgroupV2("2147483648", "1073741824"), {
    limitBytes: 2147483648,
    currentBytes: 1073741824,
  });
  assert.equal(parseCgroupV2(null, "5"), null);
  assert.equal(parseCgroupV2("max", null), null);
});

test("parseCgroupV1 maps the unlimited sentinel to a null limit", () => {
  assert.deepEqual(parseCgroupV1("9223372036854771712", "1000"), {
    limitBytes: null,
    currentBytes: 1000,
  });
  assert.deepEqual(parseCgroupV1("2147483648", "1000"), {
    limitBytes: 2147483648,
    currentBytes: 1000,
  });
  assert.equal(parseCgroupV1("abc", "1"), null);
});

// ── accelerator parsers ───────────────────────────────────────────────────

test("parseNvidiaSmi parses MiB total/free CSV rows", () => {
  const gpus = parseNvidiaSmi("24564, 21234\n24564, 100\nbogus line\n");
  assert.ok(gpus);
  assert.equal(gpus.length, 2);
  assert.deepEqual(gpus[0], {
    kind: "gpu",
    totalBytes: 24564 * MiB,
    availableBytes: 21234 * MiB,
  });
  assert.deepEqual(gpus[1], { kind: "gpu", totalBytes: 24564 * MiB, availableBytes: 100 * MiB });
});

test("parseNvidiaSmi returns null for non-matching text", () => {
  assert.equal(parseNvidiaSmi("no hardware here"), null);
});

test("parseNpuSmiHbm parses Style A 'used / total' with per-number units", () => {
  const npus = parseNpuSmiHbm("| 0 | ok | HBM: 10.5 GiB / 32 GiB |");
  assert.ok(npus);
  assert.equal(npus.length, 1);
  assert.deepEqual(npus[0], { kind: "npu", totalBytes: 32 * GiB, availableBytes: 21.5 * GiB });
});

test("parseNpuSmiHbm parses Style B with a trailing unit", () => {
  // Style B lines still need an HBM marker; without one the line is skipped.
  const npus = parseNpuSmiHbm("| 0 | 42 | 99 | 0.00% | HBM: 61032 / 65536 MB |");
  assert.ok(npus);
  assert.deepEqual(npus[0], {
    kind: "npu",
    totalBytes: 65536 * MiB,
    availableBytes: 4504 * MiB,
  });
});

test("parseNpuSmiHbm ignores lines without HBM", () => {
  assert.equal(parseNpuSmiHbm("| 0 | 42 | cpu | no accelerator info |"), null);
});

// ── planning helpers ──────────────────────────────────────────────────────

test("formatBytes formats across scales with a zero floor", () => {
  assert.equal(formatBytes(0), "0 MiB");
  assert.equal(formatBytes(-5), "0 MiB");
  assert.equal(formatBytes(Number.NaN), "0 MiB");
  assert.equal(formatBytes(100), "1 KiB");
  assert.equal(formatBytes(512 * KiB), "512 KiB");
  assert.equal(formatBytes(512 * MiB), "512 MiB");
  assert.equal(formatBytes(2 * GiB), "2.0 GiB");
  assert.equal(formatBytes(1.5 * GiB), "1.5 GiB");
});

test("suggestMaxMemoryHeavyJobs scales with availability and CPU count", () => {
  const budget = (availableBytes: number) => ({
    totalBytes: availableBytes + 1,
    availableBytes,
    unified: false,
    gpus: [] as never[],
    source: "os" as const,
  });
  assert.equal(suggestMaxMemoryHeavyJobs(budget(0)), 1);
  assert.equal(suggestMaxMemoryHeavyJobs(budget(2 * GiB)), 1);
  assert.equal(suggestMaxMemoryHeavyJobs(budget(10 * GiB)), Math.min(cpus().length, 5));
});

// ── budget + context line ─────────────────────────────────────────────────

test("getMemoryBudget returns sane values and caches within its TTL", () => {
  const b1 = getMemoryBudget();
  assert.ok(b1.totalBytes > 0);
  assert.ok(b1.availableBytes >= 0);
  assert.ok(b1.availableBytes <= b1.totalBytes);
  assert.equal(typeof b1.unified, "boolean");
  assert.ok(Array.isArray(b1.gpus));
  assert.ok(["vm_stat", "meminfo", "cgroup", "os", "unknown"].includes(b1.source));
  assert.equal(getMemoryBudget(), b1, "expected the cached budget reference");
});

test("getMemoryContextLine can be disabled via env", () => {
  withEnv("FUTURE_CODE_MEMORY_CONTEXT", "0", () => {
    assert.equal(getMemoryContextLine(), null);
  });
});

test("getMemoryContextLine describes the host when enabled", () => {
  withEnv("FUTURE_CODE_MEMORY_CONTEXT", undefined, () => {
    const line = getMemoryContextLine();
    assert.ok(line, "expected a context line on a healthy host");
    assert.ok(line.includes("Host memory:"));
  });
});

// ── OOM recognition ───────────────────────────────────────────────────────

test("diagnoseOom recognizes accelerator OOM as certain", () => {
  assert.deepEqual(diagnoseOom("CUDA out of memory", "", 1), {
    layer: "cuda",
    confidence: "certain",
  });
  assert.equal(diagnoseOom("", "RuntimeError: CUDA out of memory", 1)?.layer, "cuda");
});

test("diagnoseOom recognizes per-language heap exhaustion layers", () => {
  assert.equal(diagnoseOom("MemoryError", "", 1)?.layer, "python");
  assert.equal(diagnoseOom("FATAL ERROR: JavaScript heap out of memory", "", 1)?.layer, "javascript");
  assert.equal(diagnoseOom("terminate: std::bad_alloc", "", 1)?.layer, "cpp");
  assert.equal(diagnoseOom("memory allocation of 16 bytes failed", "", 1)?.layer, "rust");
  assert.equal(diagnoseOom("sh: cannot allocate memory", "", 1)?.layer, "generic");
});

test("diagnoseOom attributes exit 137 to the OOM killer", () => {
  assert.deepEqual(diagnoseOom("", "", 137), {
    layer: "system-oom-killer",
    confidence: "likely",
  });
  assert.equal(diagnoseOom("partial output before the kill", "", 137)?.layer, "system-oom-killer");
});

test("diagnoseOom rejects non-OOM failures", () => {
  assert.equal(diagnoseOom("cp: cannot create file: No space left on device", "", 1), null);
  assert.equal(diagnoseOom("ls: No such file or directory", "", 2), null);
  assert.equal(diagnoseOom("", "", 0), null);
});

// ── buildOomHint ──────────────────────────────────────────────────────────

test("buildOomHint emits layer, confidence, budget, recovery, and closing tag", () => {
  const hint = buildOomHint(
    { layer: "cuda", confidence: "certain" },
    {
      totalBytes: 32 * GiB,
      availableBytes: 21.5 * GiB,
      unified: false,
      gpus: [{ kind: "gpu", totalBytes: 24 * GiB, availableBytes: 20 * GiB }],
      source: "os",
    },
  );
  assert.ok(hint.startsWith('<oom-hint layer="cuda" confidence="certain">'));
  assert.ok(hint.includes("current budget: host memory 21.5 GiB available of 32.0 GiB"));
  assert.ok(hint.includes("accelerators:"));
  assert.ok(hint.includes("20.0 GiB free GPU"));
  assert.ok(hint.includes("Likely fix:"));
  assert.ok(hint.endsWith("</oom-hint>"));
});

test("buildOomHint works without a budget and adds kill diagnostics for the OOM killer", () => {
  const hint = buildOomHint({ layer: "system-oom-killer", confidence: "likely" });
  assert.ok(hint.startsWith('<oom-hint layer="system-oom-killer" confidence="likely">'));
  assert.ok(!hint.includes("current budget"));
  assert.ok(hint.includes("Check top consumers"));
  assert.ok(hint.endsWith("</oom-hint>"));
});

// ── getOomHintForOutput ───────────────────────────────────────────────────

test("getOomHintForOutput respects the env kill-switch", () => {
  withEnv("FUTURE_CODE_OOM_HINTS", "0", () => {
    assert.equal(getOomHintForOutput("CUDA out of memory", "", 1), null);
  });
});

test("getOomHintForOutput never hints on successful commands (exit 0)", () => {
  withEnv("FUTURE_CODE_OOM_HINTS", undefined, () => {
    // Regression: a successful command whose output merely mentions OOM
    // (e.g. grep hits on a training log) must not produce a hint.
    assert.equal(getOomHintForOutput("CUDA out of memory at line 3", "", 0), null);
    assert.equal(getOomHintForOutput("std::bad_alloc found in log", "all fine", 0), null);
  });
});

test("getOomHintForOutput returns a budget-sized hint for failed OOM commands", () => {
  withEnv("FUTURE_CODE_OOM_HINTS", undefined, () => {
    const hint = getOomHintForOutput("RuntimeError: CUDA out of memory", "", 1);
    assert.ok(hint, "expected a hint for a failed CUDA OOM");
    assert.ok(hint.startsWith('<oom-hint layer="cuda" confidence="certain">'));
    assert.ok(hint.endsWith("</oom-hint>"));
    assert.equal(getOomHintForOutput("plain failure", "", 1), null);
  });
});
