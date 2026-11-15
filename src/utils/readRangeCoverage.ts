// ---------------------------------------------------------------------------
// readRangeCoverage — pure predicate for coverage-based Read dedup
// ---------------------------------------------------------------------------
//
// A cached Read tool_result can satisfy a new Read request without re-reading
// the file when every line the request asks for is already inside the cached
// range. Live-transcript mining (253 sessions, 19,393 Read calls) showed 36%
// of Read calls (6,998) were subrange re-reads of an already-read, unchanged
// file — 27.6MB of redundant context — while the previous exact-match dedup
// only caught 7.5% of calls.
//
// Safety invariants this predicate relies on:
//   * An uncapped cached read (limit === undefined) only exists if it
//     succeeded end-to-end. readFileInRange throws FileTooLargeError when the
//     byte cap is hit (Read passes maxSizeBytes whenever limit is undefined)
//     and validateContentTokens throws when the token cap is hit, so a cached
//     uncapped read is guaranteed complete: its range extends to EOF.
//   * A capped cached read (limit defined) returns exactly lines
//     [offset, offset + limit) or fewer (EOF first). Treating its end as
//     offset + limit is therefore conservative: it never claims coverage of
//     lines that were not actually returned.
//   * Input offsets 0 and 1 both start at line 1 (FileReadTool maps both to
//     lineOffset 0), so they are normalized to the same start.
//
// This module is deliberately dependency-free so the offline correctness gate
// can unit-test it under `node --experimental-strip-types`.

export type ReadRange = {
  offset: number
  limit: number | undefined
}

// Input offsets 0 and 1 are equivalent (both map to lineOffset 0 in
// FileReadTool.call / callInner).
function normalizedStart(offset: number): number {
  return offset <= 1 ? 1 : offset
}

// Exclusive end line of a read range. `Infinity` for uncapped reads because
// success implies EOF was reached (see invariants above).
function rangeEnd(offset: number, limit: number | undefined): number {
  return limit === undefined ? Infinity : normalizedStart(offset) + limit
}

/**
 * True when the cached Read result already contains every line the requested
 * Read would return (ignoring file changes — callers must separately verify
 * mtime equality before trusting a cached result).
 */
export function readRangeCovers(cached: ReadRange, requested: ReadRange): boolean {
  if (normalizedStart(requested.offset) < normalizedStart(cached.offset)) {
    // Request starts before the cached range does.
    return false
  }
  // Covered iff the requested range fits inside the cached range.
  return rangeEnd(requested.offset, requested.limit) <= rangeEnd(cached.offset, cached.limit)
}
