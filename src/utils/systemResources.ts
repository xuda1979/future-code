/**
 * System memory-resource awareness for Future Code.
 *
 * Why this exists: agent-launched workloads (training jobs, builds, tests,
 * data processing) regularly die with OOM errors the harness used to treat
 * as opaque failures. This module makes the harness resource-aware in three
 * layers:
 *
 *   1. SENSE  - host RAM (respecting cgroup limits), discrete GPU VRAM,
 *               NPU HBM, and unified-memory hosts (Apple Silicon), best-effort.
 *   2. PLAN   - `getMemoryContextLine()` renders the sensed budget as
 *               conversation context so the model sizes workloads up front
 *               instead of discovering the ceiling by crashing into it.
 *   3. REACT  - `diagnoseOom()` + `buildOomHint()` recognize OOM signatures
 *               in failed command output and return concrete recovery
 *               guidance sized to the actual current budget.
 *
 * Design rules:
 *   - Every probe is best-effort with a hard timeout; sensing must never
 *     break startup or a tool call. On any failure we fall back to
 *     os.totalmem()/os.freemem().
 *   - Parsing is split into pure functions over strings so tests can verify
 *     behavior on fixture output without needing specific hardware.
 *   - No network, no PII, no logging; node-builtins only.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cpus, freemem, totalmem } from 'node:os'

const KiB = 1024
const MiB = 1024 ** 2
const GiB = 1024 ** 3

export interface GpuMemory {
  kind: 'gpu' | 'npu'
  totalBytes: number
  availableBytes: number
}

export interface MemoryBudget {
  totalBytes: number
  availableBytes: number
  /** Apple Silicon: CPU, GPU and NPU share one physical memory pool. */
  unified: boolean
  gpus: GpuMemory[]
  source: 'vm_stat' | 'meminfo' | 'cgroup' | 'os' | 'unknown'
}

export interface OomDiagnosis {
  layer:
    | 'cuda'
    | 'system-oom-killer'
    | 'python'
    | 'javascript'
    | 'cpp'
    | 'rust'
    | 'generic'
  confidence: 'certain' | 'likely'
}

/** Best-effort subprocess probe with a hard timeout; never throws. */
function tryExec(file: string, args: string[]): string | null {
  try {
    const out = execFileSync(file, args, {
      timeout: 2000,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return typeof out === 'string' ? out : null
  } catch {
    return null
  }
}

/** Best-effort file read; never throws. */
function tryRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// ────────────────────── pure parsers (unit-tested) ──────────────────────

/**
 * Parse macOS `vm_stat` output into an available-bytes estimate.
 * "Available" = memory the kernel can hand out without swapping:
 * free + speculative + purgeable + file-backed cache pages.
 */
export function parseMacVmStat(
  text: string,
  pageSize: number,
): { freeBytes: number; availableBytes: number } | null {
  const count = (key: string): number | null => {
    const m = text.match(new RegExp(`${key}[^0-9]*(\\d+)`))
    return m ? Number.parseInt(m[1], 10) * pageSize : null
  }
  const free = count('Pages free')
  if (free === null) return null
  const speculative = count('Pages speculative') ?? 0
  const purgeable = count('Pages purgeable') ?? 0
  const cached =
    count('Pages occupied by cache') ?? count('File-backed pages') ?? count('Pages cached') ?? 0
  return {
    freeBytes: free,
    availableBytes: free + speculative + purgeable + cached,
  }
}

/** Parse Linux `/proc/meminfo` content. */
export function parseLinuxMemInfo(
  text: string,
): { totalBytes: number; availableBytes: number } | null {
  const grab = (key: string): number | null => {
    const m = text.match(new RegExp(`^${key}:\\s*(\\d+) kB`, 'm'))
    return m ? Number.parseInt(m[1], 10) * KiB : null
  }
  const total = grab('MemTotal')
  if (total === null) return null
  const available =
    grab('MemAvailable') ??
    (grab('MemFree') ?? 0) + (grab('Cached') ?? 0) + (grab('Buffers') ?? 0)
  return { totalBytes: total, availableBytes: Math.min(available, total) }
}

export interface CgroupMemory {
  /** null = unlimited */
  limitBytes: number | null
  currentBytes: number
}

/** Parse cgroup v2 memory.max / memory.current file contents. */
export function parseCgroupV2(
  maxText: string | null,
  currentText: string | null,
): CgroupMemory | null {
  if (maxText === null || currentText === null) return null
  const current = Number.parseInt(currentText.trim(), 10)
  if (!Number.isFinite(current)) return null
  const raw = maxText.trim()
  const limit = raw === 'max' ? null : Number.parseInt(raw, 10)
  return { limitBytes: limit, currentBytes: current }
}

/** Parse cgroup v1 memory.limit_in_bytes / memory.usage_in_bytes contents. */
export function parseCgroupV1(
  limitText: string | null,
  usageText: string | null,
): CgroupMemory | null {
  if (limitText === null || usageText === null) return null
  const limit = Number.parseInt(limitText.trim(), 10)
  const usage = Number.parseInt(usageText.trim(), 10)
  if (!Number.isFinite(limit) || !Number.isFinite(usage)) return null
  // cgroup v1 reports "unlimited" as a near-size_t sentinel.
  return { limitBytes: limit > 1e15 ? null : limit, currentBytes: usage }
}

/** Parse `nvidia-smi --query-gpu=memory.total,memory.free` CSV (MiB, no header). */
export function parseNvidiaSmi(text: string): GpuMemory[] | null {
  const gpus: GpuMemory[] = []
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\d+),\s*(\d+)/)
    if (!m) continue
    const total = Number.parseInt(m[1], 10) * MiB
    const free = Number.parseInt(m[2], 10) * MiB
    if (total > 0 && free >= 0) {
      gpus.push({ kind: 'gpu', totalBytes: total, availableBytes: free })
    }
  }
  return gpus.length > 0 ? gpus : null
}

/** Parse HBM usage rows out of `npu-smi info` output (Ascend NPUs). */
export function parseNpuSmiHbm(text: string): GpuMemory[] | null {
  const unitBytes = (u: string): number => (/GiB|GB/i.test(u) ? GiB : MiB)
  const gpus: GpuMemory[] = []
  for (const line of text.split('\n')) {
    if (!/HBM/i.test(line)) continue
    // Style A: "10.5 GiB / 32 GiB" — unit after each number.
    let used: number | null = null
    let total: number | null = null
    const styleA = line.match(
      /(\d+(?:\.\d+)?)\s*(MiB|GiB|MB|GB)\s*\/\s*(\d+(?:\.\d+)?)\s*(MiB|GiB|MB|GB)/i,
    )
    if (styleA) {
      used = parseFloat(styleA[1]) * unitBytes(styleA[2])
      total = parseFloat(styleA[3]) * unitBytes(styleA[4])
    } else {
      // Style B: "10485 / 21534 MB" — single trailing unit (npu-smi default).
      const styleB = line.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*(MiB|GiB|MB|GB)/i)
      if (styleB) {
        const unit = unitBytes(styleB[3])
        used = parseFloat(styleB[1]) * unit
        total = parseFloat(styleB[2]) * unit
      }
    }
    if (used !== null && total !== null && total > 0) {
      gpus.push({
        kind: 'npu',
        totalBytes: total,
        availableBytes: Math.max(0, total - used),
      })
    }
  }
  return gpus.length > 0 ? gpus : null
}

// ────────────────────────────── sensing ──────────────────────────────

function senseGpuMemories(): GpuMemory[] {
  const gpus: GpuMemory[] = []
  const nvidia = tryExec('nvidia-smi', [
    '--query-gpu=memory.total,memory.free',
    '--format=csv,noheader,nounits',
  ])
  if (nvidia) {
    const parsed = parseNvidiaSmi(nvidia)
    if (parsed) gpus.push(...parsed)
  }
  const npu = tryExec('npu-smi', ['info'])
  if (npu) {
    const parsed = parseNpuSmiHbm(npu)
    if (parsed) gpus.push(...parsed)
  }
  return gpus
}

function senseHostMemory(): {
  totalBytes: number
  availableBytes: number
  source: MemoryBudget['source']
} {
  if (process.platform === 'darwin') {
    const vmStat = tryExec('vm_stat', [])
    if (vmStat) {
      // vm_stat prints its own page size; 16 KiB on Apple Silicon,
      // but fall back safely if the header ever changes.
      const sizeMatch = vmStat.match(/page size of (\d+) bytes/)
      const pageSize = sizeMatch ? Number.parseInt(sizeMatch[1], 10) : 16384
      const parsed = parseMacVmStat(vmStat, pageSize)
      if (parsed) {
        return {
          totalBytes: totalmem(),
          availableBytes: Math.min(parsed.availableBytes, totalmem()),
          source: 'vm_stat',
        }
      }
    }
  }
  if (process.platform === 'linux') {
    const meminfo = tryRead('/proc/meminfo')
    if (meminfo) {
      const parsed = parseLinuxMemInfo(meminfo)
      if (parsed) {
        let { totalBytes, availableBytes } = parsed
        let source: MemoryBudget['source'] = 'meminfo'
        const cgroup =
          parseCgroupV2(
            tryRead('/sys/fs/cgroup/memory.max'),
            tryRead('/sys/fs/cgroup/memory.current'),
          ) ??
          parseCgroupV1(
            tryRead('/sys/fs/cgroup/memory/memory.limit_in_bytes'),
            tryRead('/sys/fs/cgroup/memory/memory.usage_in_bytes'),
          )
        if (cgroup && cgroup.limitBytes !== null) {
          // Inside a container: the cgroup ceiling is the real budget.
          totalBytes = Math.min(totalBytes, cgroup.limitBytes)
          availableBytes = Math.min(
            availableBytes,
            Math.max(0, cgroup.limitBytes - cgroup.currentBytes),
          )
          source = 'cgroup'
        }
        return {
          totalBytes,
          availableBytes: Math.min(availableBytes, totalBytes),
          source,
        }
      }
    }
  }
  return {
    totalBytes: totalmem(),
    availableBytes: Math.min(freemem(), totalmem()),
    source: 'os',
  }
}

let cachedBudget: MemoryBudget | undefined
let cachedAt = 0
const BUDGET_TTL_MS = 30_000

/**
 * Sense the host memory budget. Results are cached briefly so repeated
 * tool calls don't re-probe; pass `refresh` to force a fresh sample.
 */
export function getMemoryBudget(refresh = false): MemoryBudget {
  const now = Date.now()
  if (!refresh && cachedBudget && now - cachedAt < BUDGET_TTL_MS) {
    return cachedBudget
  }
  const host = senseHostMemory()
  const budget: MemoryBudget = {
    ...host,
    unified: process.platform === 'darwin' && process.arch === 'arm64',
    gpus: senseGpuMemories(),
  }
  cachedBudget = budget
  cachedAt = now
  return budget
}

// ────────────────────────────── planning ──────────────────────────────

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MiB'
  if (bytes >= GiB) return `${(bytes / GiB).toFixed(1)} GiB`
  if (bytes >= MiB) return `${Math.round(bytes / MiB)} MiB`
  return `${Math.max(1, Math.round(bytes / KiB))} KiB`
}

function safeCpuCount(): number {
  try {
    return cpus().length
  } catch {
    return 4
  }
}

/** Suggested cap on concurrent memory-heavy jobs for the current budget. */
export function suggestMaxMemoryHeavyJobs(
  budget: MemoryBudget,
  cpuCount = safeCpuCount(),
): number {
  const availableGiB = budget.availableBytes / GiB
  if (availableGiB <= 0) return 1
  return Math.max(1, Math.min(cpuCount, Math.floor(availableGiB / 2)))
}

function isEnvFalsy(v: string | undefined): boolean {
  return v !== undefined && /^(0|false|no|off)$/i.test(v.trim())
}

/**
 * Compact memory context for conversation context, so the model sizes
 * workloads up front. Returns null when sensing failed or the user
 * disabled it (FUTURE_CODE_MEMORY_CONTEXT=0).
 */
export function getMemoryContextLine(): string | null {
  if (isEnvFalsy(process.env.FUTURE_CODE_MEMORY_CONTEXT)) return null
  let budget: MemoryBudget
  try {
    budget = getMemoryBudget()
  } catch {
    return null
  }
  if (!(budget.totalBytes > 0)) return null

  const parts: string[] = []
  parts.push(
    `Host memory: ${formatBytes(budget.totalBytes)} total, ${formatBytes(budget.availableBytes)} available` +
      (budget.unified
        ? ' (Apple Silicon unified memory: CPU, GPU and NPU share this pool - no separate VRAM/HBM)'
        : ''),
  )
  if (budget.gpus.length > 0) {
    const accel = budget.gpus
      .map(
        (g) =>
          `${formatBytes(g.availableBytes)} free of ${formatBytes(g.totalBytes)} ${g.kind.toUpperCase()}`,
      )
      .join('; ')
    parts.push(`Accelerators: ${accel}`)
  }
  const bigAlloc = Math.floor(budget.availableBytes / 4)
  parts.push(
    `Memory guidance: keep any single in-memory dataset or batch under ${formatBytes(bigAlloc)} (1/4 of available), ` +
      `cap concurrent memory-heavy jobs at ${suggestMaxMemoryHeavyJobs(budget)}, ` +
      `stream or memory-map larger data, and prefer chunked processing over loading whole inputs`,
  )
  if (budget.unified) {
    parts.push(
      'GPU/NPU workloads draw from the same pool - free accelerator caches (e.g. torch.mps.empty_cache()) instead of assuming separate VRAM',
    )
  }
  return parts.join(' | ')
}

// ─────────────────────────── OOM recognition ───────────────────────────

const OOM_SIGNATURES: Array<{
  re: RegExp
  layer: OomDiagnosis['layer']
  confidence: OomDiagnosis['confidence']
}> = [
  // Accelerator OOMs are unambiguous and have a dedicated recovery path.
  {
    re: /CUDA out of memory|HIP out of memory|CUDA error: out of memory|out of memory on (GPU|HBM|NPU)|HBM out of memory/i,
    layer: 'cuda',
    confidence: 'certain',
  },
  {
    re: /torch\.(cuda\.)?OutOfMemoryError|c10(::)?(Error|OutOfMemoryError).*out of memory/i,
    layer: 'cuda',
    confidence: 'certain',
  },
  // Kernel OOM-killer / SIGKILL signatures as reported by shells.
  {
    re: /Killed: 9|exit (code|status) 137|zsh: killed|sh: \d+:.*[Kk]illed|bash: line \d+:.*[Kk]illed|invoked oom-killer|Out of memory: Kill process|oom_reaper/i,
    layer: 'system-oom-killer',
    confidence: 'certain',
  },
  { re: /\bMemoryError\b|_ArrayMemoryError|numpy\.\S*out of memory/i, layer: 'python', confidence: 'likely' },
  {
    re: /JavaScript heap out of memory|FATAL ERROR: (Reached heap limit|CALL_AND_RETRY_LAST)|RUN_OUT_OF_MEMORY/i,
    layer: 'javascript',
    confidence: 'likely',
  },
  {
    re: /std::bad_alloc|terminate called after throwing an instance of ['"A-Za-z:]*bad_alloc/i,
    layer: 'cpp',
    confidence: 'likely',
  },
  { re: /memory allocation of \d+ bytes failed|capacity overflow/i, layer: 'rust', confidence: 'likely' },
  { re: /cannot allocate (memory|\d+ bytes)|out of memory/i, layer: 'generic', confidence: 'likely' },
]

/**
 * Recognize OOM signatures in failed-command output.
 * Returns the highest-priority diagnosis, or null when the output looks
 * like a different failure class (disk full, missing file, ...).
 */
export function diagnoseOom(
  stdout: string,
  stderr: string,
  exitCode?: number | null,
): OomDiagnosis | null {
  const output = `${stdout}\n${stderr}`
  if (output.length === 0) {
    // Bare exit 137 (128+9, SIGKILL) still smells like the OOM killer.
    return exitCode === 137 ? { layer: 'system-oom-killer', confidence: 'likely' } : null
  }
  // Disk-full is the most common "looks like OOM but isn't" failure:
  // ENOSPC needs disk cleanup, not smaller batches.
  if (/No space left on device|ENOSPC/i.test(output)) return null
  for (const sig of OOM_SIGNATURES) {
    if (sig.re.test(output)) {
      return { layer: sig.layer, confidence: sig.confidence }
    }
  }
  // Shell-suppressed kill message: exit 137 (128+9) alone.
  if (exitCode === 137) {
    return { layer: 'system-oom-killer', confidence: 'likely' }
  }
  return null
}

const LAYER_RECOVERY: Record<OomDiagnosis['layer'], string> = {
  cuda:
    'reduce batch size or model shard, enable mixed precision (bf16/fp16), add gradient accumulation, chunk activations, or free the cache (e.g. torch.cuda.empty_cache()); check for other processes holding accelerator memory',
  'system-oom-killer':
    'the OS killed the process for exceeding memory - reduce the dataset/batch size, stream or memory-map inputs, lower worker/parallelism counts, or close other large processes first',
  python:
    'process data in chunks, use memory-mapped files (np.memmap) or generators, reduce batch size, or lower parallelism',
  javascript:
    'stream large payloads to disk instead of holding them in the JS heap, process in chunks, or reduce in-memory caches',
  cpp:
    'reduce allocation size, reserve capacity up front, stream from disk, or shrink the working set',
  rust: 'reduce allocation size, process in chunks, or use a streaming reader instead of loading whole inputs',
  generic:
    'reduce working-set size, process in chunks, lower parallelism, or free other memory before retrying',
}

/** Model-facing recovery guidance, sized to the real current budget. */
export function buildOomHint(diagnosis: OomDiagnosis, budget?: MemoryBudget): string {
  const lines: string[] = [
    `<oom-hint layer="${diagnosis.layer}" confidence="${diagnosis.confidence}">`,
  ]
  if (budget && budget.totalBytes > 0) {
    const host = `current budget: host memory ${formatBytes(budget.availableBytes)} available of ${formatBytes(budget.totalBytes)}`
    const accel =
      budget.gpus.length > 0
        ? `; accelerators: ${budget.gpus
            .map((g) => `${formatBytes(g.availableBytes)} free ${g.kind.toUpperCase()}`)
            .join(', ')}`
        : budget.unified
          ? '; CPU/GPU/NPU share unified memory'
          : ''
    lines.push(`${host}${accel}.`)
  }
  lines.push(`Likely fix: ${LAYER_RECOVERY[diagnosis.layer]}.`)
  if (diagnosis.layer === 'system-oom-killer') {
    lines.push('Check top consumers with `ps aux --sort=-rss | head` before retrying.')
  }
  lines.push('</oom-hint>')
  return lines.join(' ')
}

/**
 * Combined helper for tool-result paths: diagnose OOM in a failed
 * command's output and, when found, return budget-aware guidance.
 * Returns null when the output shows no OOM signature.
 */
export function getOomHintForOutput(
  stdout: string,
  stderr: string,
  exitCode?: number | null,
): string | null {
  if (isEnvFalsy(process.env.FUTURE_CODE_OOM_HINTS)) return null
  // Defense in depth: exit-0 commands never get OOM hints, even if their
  // output merely mentions OOM text (e.g. grep hits on a log file).
  if (exitCode === 0) return null
  const diagnosis = diagnoseOom(stdout, stderr, exitCode)
  if (!diagnosis) return null
  let budget: MemoryBudget | undefined
  try {
    budget = getMemoryBudget()
  } catch {
    budget = undefined
  }
  return buildOomHint(diagnosis, budget)
}
