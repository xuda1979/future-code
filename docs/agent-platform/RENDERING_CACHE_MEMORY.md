# Rendering cache memory

This follow-up builds on the merged file-cache/output changes in PR #100.
It addresses three additional retention paths in the terminal UI. A screenshot
showing roughly 15 GiB used on a 16 GiB Mac identifies system-wide pressure;
it cannot attribute that memory to five Future Code processes. Child builds,
language servers, MCP processes, the terminal, and native allocations also count.

## Changes and behavior

| Derived cache | Previous policy | New policy |
| --- | --- | --- |
| Markdown parse trees | Up to 500 entries, including successive streaming variants | 500 entries and an 8 MiB estimated charge; streaming variants bypass this history cache |
| Terminal grapheme arrays | Up to 16,384 lines before a whole-cache clear on a later frame | 16,384 entries and an 8 MiB estimated charge **per Output instance**, with LRU eviction on insertion |
| Line widths | 4,096 string keys, then whole-cache clear | 4,096 entries and a 1 MiB estimated charge, with LRU eviction |

The Markdown budget includes nested tokens, raw/text strings, reference links,
object/array bookkeeping, and keys. The terminal budget includes grapheme
objects, their values, hyperlink runs, keys, and bookkeeping. These are
conservative retention charges, not measured RSS or an overall process limit.

An oversized result is still returned in full; it is not cached and does not
eject the useful small working set. Hits keep recently viewed data hot. Flat
string copies prevent a short cached line/token substring from pinning a much
larger parent string. UTF-8 keeps normal strings compact; a UTF-16 fallback
preserves lone surrogates and other input exactly.

Streaming components retain their existing mounted-render memoization and stable
block boundary logic. Their changing prefixes and suffixes no longer fill the
module-level history cache. Completed messages still use that cache when the
virtual scroller remounts them. Parsing, syntax highlighting, screen cells,
colors, hyperlinks, Unicode widths, and model prompts are otherwise unchanged.
No transcript, task evidence, tool output, or active model context is discarded.
There is no production forced-GC loop, heap cap, concurrency reduction, or
reduction of reasoning effort.

Cold UI data can require parsing or width calculation again after eviction. A
bounded cache cannot guarantee unchanged latency for every arbitrarily large
scrollback working set. This change preserves the active working set and checks
hot reuse explicitly instead of treating lower memory as proof of productivity.

## Measurement

The baseline is `e715028b5e3d11775e23188e755ad3cb9acef45b`, including PR #100.
The harness runs the production parser and terminal rendering in fresh Node
processes, alternates revision order, authenticates sources/dependencies, and
compares complete token and screen-cell hashes. Debug logging is isolated.
The baseline's private lexer is exposed by TSX transpilation without changing
its implementation. Explicit GC is confined to measurement workers.

| Stress scenario | Baseline retained heap | Candidate retained heap | Reduction |
| --- | ---: | ---: | ---: |
| 600 growing Markdown variants | 73.70 MiB | 0.26 MiB | 99.64% |
| 300 completed 64 KiB messages | 38.13 MiB | 4.25 MiB | 88.85% |
| 12,000 distinct 120-character terminal lines | 92.52 MiB | 5.64 MiB | 93.90% |

These are medians of five samples per revision and scenario (30 isolated
workers) on Node v24.22.1/Linux x64. All complete token/cell hashes match across
revisions. Each hot check performed **zero reparses or character rebuilds**.

| Median local timing | Baseline | Candidate |
| --- | ---: | ---: |
| streaming: stress scan including hash checks | 1899.54 ms | 1376.35 ms |
| streaming: 10,000 hot Markdown hits | 103.83 ms | 82.85 ms |
| history: stress scan including hash checks | 488.77 ms | 570.93 ms |
| history: 10,000 hot Markdown hits | 89.65 ms | 78.45 ms |
| characters: stress scan including hash checks | 1849.48 ms | 1606.73 ms |
| characters: 500 hot terminal frames | 194.88 ms | 180.02 ms |

The cold completed-history scan was 16.8% slower (about 0.27 ms per 64 KiB
message in this fixture). It includes lossless input detachment and conservative
graph accounting; eviction can also require rebuilding old data on revisit.
Hot-path medians improved in this pass, but individual timings were noisy: no
universal latency or productivity guarantee follows from these microbenchmarks.
The byte-budget/LRU invariants and zero hot rebuilds are deterministic checks.

[Raw runs, source hashes, dependency versions and measurement contract](measurements/rendering-cache-memory-20261112.json).

These synthetic cases measure retained JavaScript heap in the affected paths.
They do not measure total CLI RSS, five live Mac sessions, peak memory across
the system, end-to-end agent productivity, or model quality. The per-cache
budgets must not be interpreted as a total-session memory guarantee.

## Reproduce

With the normal project dependencies installed, use Node 24 for the benchmark.
It additionally needs Babel to expose the baseline TSX function. For an isolated
rendering-only dependency environment:

```sh
npm install --prefix /tmp/future-render-deps --no-audit --no-fund --ignore-scripts \
  marked@18.0.9 @alcalzone/ansi-tokenize@0.3.0 bidi-js@1.0.3 \
  emoji-regex@10.6.0 get-east-asian-width@1.6.0 strip-ansi@7.2.0 \
  @babel/core@8.1.2 @babel/preset-typescript@8.0.7 \
  @babel/plugin-transform-react-jsx@8.0.1
# Only when this checkout has no node_modules directory:
ln -s /tmp/future-render-deps/node_modules node_modules
node scripts/bench-render-cache-memory.mjs \
  --baseline-ref e715028b5e3d11775e23188e755ad3cb9acef45b \
  --samples 5 --output render-memory.json
```

The parser/terminal dependency versions above match `bun.lock`. The benchmark
does not invoke an LLM or need credentials.

## Regression checks

```sh
node --experimental-strip-types --test \
  tests/correctness/byte-bounded-cache.test.ts \
  tests/rendering/render-cache.test.ts
bun test --preload ./tests/rendering/bun-isolation.ts \
  tests/correctness/byte-bounded-cache.test.ts \
  tests/rendering/render-cache.test.ts
node scripts/test-correctness.mjs
node scripts/test-commands.mjs
```

The dependency-free cache tests are part of the standard correctness gate.
The rendering tests use real dependencies and isolate only debug logging. CI
adds both Node and Bun rendering checks on Linux and macOS. Local Linux
validation passed: all 13 focused cases under both Node v24.22.1 and Bun v1.4.4; the correctness gate and command suite; and Bun transpilation of
the five changed rendering modules. A complete CLI binary build, live-provider
productivity runs, and local macOS/Apple Silicon profiling were not performed.
The added macOS CI job is separate from these local results.

## Identify remaining memory on a Mac

Capture the process tree while the five sessions are under pressure:

```sh
ps -axo pid,ppid,rss,command | sort -nr -k3 | head -30
vm_stat
sysctl vm.swapusage
```

RSS is reported in KiB by `ps`; shared pages and compressed memory mean that
summing RSS is not an exact system-memory total. Compare idle sessions, active
streaming, scrolling, and running builds separately. Attribute shell/build/MCP
children to their parent session before choosing another optimization. This
avoids lowering agent concurrency or context based on an unrelated consumer.

Existing sessions use their currently running binary. Rebuild/update from the
merged revision and resume saved sessions to adopt these changes. This PR does
not replace a running Mac binary or restart sessions.
