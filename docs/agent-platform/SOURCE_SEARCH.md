# Review: reduce the work needed to find relevant code

Review baseline: main `bf7c34461793bb7ef8e422c5fefdffd72d89d996`.

Future-Code already has indexed dispatch, bounded read batches, early evaluation,
diagnostic memory, provider recovery, independent checks and a paired-project
evaluation protocol. The next improvements should remove observed work from
those paths and measure time to independently accepted output.

| Priority | Finding | Action |
|---|---|---|
| 1 | Swarm's advertised filesystem tools can list names and read files but cannot search their contents. Locating an unfamiliar symbol can consume many reads, model turns and repeated context bytes. The terminal CLI already has a separate search tool. | This change adds bounded `search_files` to local and remote Swarm workers. Search for a symbol or diagnostic, then read the relevant range and test the proposed repair. |
| 2 | Named measurement policies are enforced in Foundry/Swarm; the ordinary terminal `/goal` path receives decision guidance through a different runtime. | Select the governed entrypoint for supervised experiments. A future unification should preserve terminal permission handling, tools and replay semantics, with equivalent admission tests. |
| 3 | Many impressive repository benchmarks use scripted provider replies. They establish host behavior, but do not establish real R&D productivity or scientific judgment. | Use the existing paired real-project protocol, including failed trials, time to first useful measurement, accepted output, actual requests and human interventions. |
| 4 | Existing timing records distinguish provider admission, tools, verification and remote RPCs. More orchestration is useful only when it shortens the actual bottleneck. | Compare measured phases before adding agents or changing defaults. Enable independent verifier parallelism only for checks the operator can declare independent. |

This implementation adds source discovery, not AST indexing, a language server,
provider-owned KV caching or a scientific evaluator. It contains no knowledge of
an individual R&D project.

## Enable and use

Add `"search_files"` to an agent profile's `tools` before initialization. The
supervised R&D example now includes it; the basic example retains its smaller
tool roster for known, short edits. Existing pinned configurations and
threads retain their original capabilities; changing a frozen contract requires
a newly initialized root. Deploy and repin the updated `swarm-worker-agent.py`
when using remote workers. An older endpoint returns an ordinary unknown-tool
error rather than gaining the capability automatically.

```json
{
  "query": "reserveRequest",
  "path": "src/runtime",
  "limit": 20,
  "contextLines": 3
}
```

`query` is a case-sensitive, single-line literal of 1–256 UTF-8 bytes. There is no
regex, glob, shell interpolation or external `rg` dependency. `path` optionally
narrows the search to a literal file/directory prefix; omit it to use all readable
task scopes. A parent prefix can narrow several readable subdirectories, but
never grants access to the rest of that parent.

`contextLines` optionally includes up to 20 adjacent lines on each side of a
match, reusing the file read already performed by discovery. A worker can inspect
nearby code without another model/search/read round trip. Each match's `context`
contains `startLine`, `endLine`, `content` and `truncated`; context is bounded to
8 KiB and the existing page output budget. Oversized matching lines use the hit
excerpt and explicitly mark truncation. The default zero omits the context field.
Pagination, scopes, receipt ownership and independent acceptance remain the same.
This is one finite read operation. Any end-to-end productivity benefit still
requires measurement on the target workload.

Results contain `matches` with file path, 1-based line, an excerpt around the
first hit on that line and an excerpt `truncated` flag. `nextCursor` is either
null or an inclusive `{ "path": "...", "line": 123 }` continuation. Pass it as
`cursor` with the same query/path to continue. File order is lexicographic UTF-8.
Restart from the beginning after edits, checks that change source, or worker
replacement: this cursor is a location, not a snapshot certificate. Returned
receipts retain the original observations through normal journal replay and
context retirement.

Each page also reports `scannedFiles`, `skippedFiles` and `bytesRead`. These are
page-local counts. A null cursor means that this page exhausted the selected
inventory; skipped inputs and prior pages still need to be considered. Empty
results never constitute an acceptance check or proof of absence.

## Bounds and authority

| Bound | Behavior |
|---|---|
| Inventory | Pinned Git lists tracked and nonignored new paths, narrowed before file reads; captured inventory is capped at 16 MiB. An over-budget inventory fails visibly rather than returning a partial listing. |
| Scope | Files must be within `writeScope` or `readScope`, and within the optional path prefix. Admission validates queries/cursors before dispatch; each backend checks scope again. |
| Files | At most 256 files are inspected per page. Symlinks, nonregular/missing/unreadable files, unsafe paths, binary/NUL data, invalid UTF-8 and oversized files increment `skippedFiles`. |
| Input bytes | File size limit is `min(maxToolOutputBytes, 1 MiB)`; reads include at most one extra length-guard byte. The scan reserves at most `min(8 MiB, 64 * file-size-limit)` per page, including returned guards from files that grew. |
| Matches/output | Default 20 matching lines, configurable 1–100. Excerpts include up to 40 Unicode characters before and 80 after the literal. Metadata and continuation must fit `maxToolOutputBytes`; otherwise return a resumable page or a visible insufficient-budget error. |
| Time | Scan loops observe the configured tool deadline and return a continuation. Local cancellation and existing bounded Git/RPC deadlines still apply; these controls do not sandbox untrusted code or make filesystem reads preemptible. |
| Effects | Read-only, replay-safe observation. Adjacent reads share the existing four-slot batch and exact duplicate-call I/O deduplication. Edits, checks, jobs and control effects remain ordering barriers. |

Search includes the current private worktree, including staged edits, restored
patches and nonignored untracked files. Ignored untracked files are omitted;
explicitly written/force-staged ignored files remain tracked and discoverable.
Search results use owned tool receipts and retain ordinary tool budget charges.
They cannot clear measurement requirements, certify a claim, admit a job or
satisfy independent task/final integration checks.

## Reproduce the comparison

`scripts/bench-source-search.mjs` compares two explicit discovery policies over
the same synthetic corpus: listing plus 32-file read batches, and bounded literal
search. The target symbol is in the last filename; the file names provide no
semantic hints. Both arms edit observed text and run real independent task and
integration checks. A known-file workload directly edits a supplied path in both
arms, exposing schema/input overhead without introducing a discovery step.

```sh
git worktree add --detach /tmp/future-code-source-baseline bf7c344
node --experimental-strip-types scripts/bench-source-search.mjs \
  --runtime-root /tmp/future-code-source-baseline --mode browse --repetitions 5
node --experimental-strip-types scripts/bench-source-search.mjs \
  --mode search --repetitions 5
```

The [recorded comparison](validation/source-search-20261015.json) uses 10
repetitions per arm/workload in baseline/candidate/candidate/baseline order,
followed by five repetitions of each workload on the candidate with its minimal
profile. Every one of the 50 trials passes task and final integration checks.

| 256-file discovery fixture | Baseline browse | Search enabled |
|---|---:|---:|
| Scripted provider requests | 16 | 3 |
| Tool calls | 263 | 2 |
| Encoded request bytes | 527,866 | 16,340 |
| Median task + integration host time | 3,088 ms | 797 ms |

For the known-file edit, both arms use two requests and one tool call. Enabling
search increases total encoded input from 8,426 to 10,426 bytes; median host time
in these samples increases from 512 to 697 ms. The later candidate control with
search omitted retains exactly the original counts/bytes and records a 527 ms
median. These small measurements do not isolate every cause of timing variation
or establish a universal short-task latency guarantee. Keep the minimal profile
for known, short edits; grant source search to workers that need discovery.

The fixture uses scripted provider replies, no live models and no simulated
network delay. Its request counts compare these particular discovery policies;
they are not a prediction of model behavior, billed tokens, dollars or arbitrary
project speedup. Enabling search adds a tool schema to each request; profiles that
omit it incur no search schema/guidance overhead. See the recorded validation
artifact for raw timing/request samples and exact source hashes.

## Validation

Focused regressions exercise local and actual Python worker endpoints, literal
UTF-8 results, pagination, scope denial, skip reporting, file/byte/output limits,
untracked/ignored files, private edits, cancellation, read batches, owned receipts
and independent task plus final integration checks. The new file is included in
both the Foundry and Swarm test gates.

```sh
node --experimental-strip-types --test tests/foundry/source-search.test.ts \
  tests/foundry/tool-batching.test.ts tests/foundry/remote-tool-batching.test.ts
node scripts/test-correctness.mjs
node scripts/test-resilience.mjs
node scripts/test-foundry.mjs
node scripts/test-swarm.mjs
node scripts/test-commands.mjs
```
