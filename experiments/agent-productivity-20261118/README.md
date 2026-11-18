# Future-Code comparative productivity experiments

November 18, 2026

On a scripted one-file repair, the startup fix moved Future-Code from 0/5 to
5/5 verified completions. Future-Code took a median 1.58 s, compared with
5.60 s for OpenCode and 1.07 s for Claude Code under the tested profiles.
The accelerated remote-job experiment also recovered the original job after
a 42-hour simulated outage. Overall product rankings require more data.

[Recorded results](observations.json) preserve verified counts, timings,
outcomes, and source identifiers observed before the execution environment
disconnected. The original transient per-run replay, transport, and live logs
were unavailable at publication. The commands below regenerate the records.
[Technical report](../../docs/release/FUTURE_CODE_TECHNICAL_REPORT_EN.md)

## Short repair

Use Linux x86_64, Node 24.22.3, Python 3.12.14, and Bun 1.4.2. Run the
commands from the repository root. The existing general R&D fixture supplies
the defective metrics file, a known failing check, and an external verifier.
The trial runner rejects out-of-scope changes and requires the checker to pass
before recording a verified edit. Compare accepted completions first. Time
successful edits only when comparing latency between arms with matching pass
counts. Count failed and timed-out trials in throughput.

Each new process gets a fresh Git worktree and an isolated CLI state directory.
Future-Code and Claude Code use their minimal headless modes with edit
permissions. OpenCode uses headless mode with external plugins off. Prompts
and scripted tool intentions match. Tool schemas, native CLI initialization,
and auxiliary provider calls can differ. Five repetitions rotate agent order.

~~~sh
git worktree add --detach ../future-first b1f9d186085562947adf682f4c7f65652886ecad
git worktree add --detach ../future-main f4dcea1645510e76af1a619663487f1b281c2b09
git worktree add --detach ../future-fixed 2692c00fe85926f13d23f25c6435d1c1a7d7a168
(cd ../future-main && bun install --frozen-lockfile &&
  bun build src/entrypoints/cli-bundle.ts --compile --outfile=../future-main-bin --target=bun)
(cd ../future-fixed && bun install --frozen-lockfile &&
  bun build src/entrypoints/cli-bundle.ts --compile --outfile=../future-fixed-bin --target=bun)
ln -s ../future-main/node_modules ../future-first/node_modules
(cd ../future-first && bun build src/entrypoints/cli-bundle.ts --compile \
  --outfile=../future-first-bin --target=bun)
npm install --prefix ../comparison-tools --save-exact \
  opencode-ai@1.19.6 @anthropic-ai/claude-code@2.1.327 @opencode/ai@2.3.0
python3 scripts/bench-agent-cli-replay.py --out ../cli-replay --repetitions 5 \
  --agent first-compatible=../future-first-bin --agent baseline=../future-main-bin \
  --agent candidate=../future-fixed-bin \
  --agent claude-code=../comparison-tools/node_modules/.bin/claude \
  --agent opencode=../comparison-tools/node_modules/.bin/opencode
~~~

The first arm uses the actual root source and the current dependency tree.
The legacy packages referenced by its exact lockfile returned HTTP 404. This
compatibility build and current main both failed during option registration.
The fix was compiled and tested with the same source tree published at
`2692c00`.

## Provider transport

Run the three-arm probe from the report branch. Its current Python proxy
source is unchanged from `f4dcea1`. The controls use immediate EOF and a
200 ms post-completion socket hold. Each sample excludes one warmup request.
The probe verifies matching tool arguments, usage fields, local file contents,
and expected upstream request counts. Both historical and current spacing
settings are zero.

~~~sh
NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
  python3 scripts/bench-provider-terminal.py ../future-first --samples 5 --hold-ms 200 \
  --opencode-runtime ../comparison-tools --output ../provider-transport.json
~~~

## Remote job recovery

A scripted endpoint drives the production scheduler, session journal, and
SQLite store through an accelerated clock. The test preserves the original
job ID across two controller reopenings and checks the expected terminal
result. It separately verifies zero task acceptances in both arms.

~~~sh
git worktree add --detach ../future-before-recovery 4dbd9e2
node scripts/bench-week-job-outage.mjs ../future-before-recovery blocked
node scripts/bench-week-job-outage.mjs ../future-main recovered
~~~

## Model-backed pilot

The [frozen contract](live-contract.json) specifies four cases and three
repetitions per client, with a 90 s agent deadline. The two observed timeout
rows were the first metrics repair for Future-Code and for Claude Code.
The OpenCode trial started before the execution environment disconnected.
The four generic cases are small repository repairs. The job-idempotence case
covers a remote-job policy change, while actual multi-day recovery needs its
own benchmark. Codex CLI and WorkBuddy Desktop remain unmeasured. The
installed Tencent CodeBuddy Code package identifies a separate client.
[Tencent client documentation](https://cloud.tencent.com/document/product/1831/140223)

Serve the weights and runtime pinned in the contract. The model file's SHA-256
is pinned there. The loopback gateway uses the same checkpoint, temperature,
and output ceiling for all three clients. It keeps the native Messages and
Chat Completions interfaces used by the clients. End-to-end differences also
include prompt and tool overhead. The test used a single CPU slot and
observed slow prompt processing. A host that can serve the model within the
trial deadline is required to measure completed tasks.

~~~sh
llama-server --model /path/to/Qwen3-4B-Instruct-2507-Q4_K_M.gguf \
  --alias qwen3-4b-instruct-2507 --host 127.0.0.1 --port 18083 \
  --ctx-size 16384 --threads 6 --threads-batch 8 --parallel 1 \
  --jinja --temp 0 --no-ui --no-warmup
~~~

With the server ready, run this command on the same host.

~~~sh
python3 experiments/agent-productivity-20261118/run-live.py \
  --future-code ../future-fixed-bin --port 18083 --out ../cli-live \
  --claude-code ../comparison-tools/node_modules/.bin/claude \
  --opencode ../comparison-tools/node_modules/.bin/opencode
~~~

The cross-agent runner requires a complete, unique matrix before it publishes
comparative observations. For expanded coverage, use independent held-out
projects with a mix of short repairs, integration work, and week-long jobs.
Freeze input revisions, model settings, budgets, interruption schedules,
verifiers, and the decision rule before launch. Include unsuccessful wall time
and operator interventions. Compare agents pairwise by task, with uncertainty
across independent projects. Report same-model and best-product trials
separately.

[Generic comparison fixture guide](../../examples/agent-comparison/README.md) ·
[OpenCode CLI](https://opencode.ai/docs/cli/commands) ·
[Claude Code CLI](https://code.claude.com/docs/en/headless) ·
[Codex CLI](https://learn.chatgpt.com/docs/non-interactive-mode) ·
[llama.cpp server](https://github.com/ggml-org/llama.cpp/tree/398f00d65769e73bb5cad57c809429b160f2bb0e/tools/server)

## Source discovery and dispatch

The 42 recorded trials used Linux x86-64, Node 24.22.3, Git 2.52.0 and an
Intel Xeon Platinum 8573C. The measured runtime revisions are `22cb45f` and
`40c9588`. Published revision `70f1be2` has the same Git tree as the
measured candidate, `c6c5ecc739d0ba1aaeb331649ae1e5f6051b41f7`. Run six
repetitions with the fixture runner from the published candidate
revision. It rotates arm order by repetition. The three-arm symbol workload
includes a candidate receiving the exact same eight single-literal calls as
the parent, and a candidate receiving one combined call. All eight baseline
calls arrive together in one provider response. No artificial I/O or network
delay is inserted. The runner emits every trial, including any failure,
and exits nonzero on a failed check. [Recorded samples](discovery-samples.csv)

~~~sh
git worktree add --detach ../future-discovery-parent 22cb45f
git worktree add --detach ../future-discovery-candidate 70f1be2
node --experimental-strip-types ../future-discovery-candidate/experiments/agent-productivity-20261118/bench-discovery.mjs \
  ../future-discovery-parent ../future-discovery-candidate 6 > discovery.json
~~~

Each trial starts with a fresh SQLite store and the same 192 files. The
provider fixture derives the answer from tool outputs. Task verification and
integration both check the exact bytes. Timing starts at `runSwarm` and ends
after `integrateSwarm`, including workspace setup, tool calls, journaling,
verification and integration. Fixture creation, the initial failing check and
one-time Swarm initialization occur before timing. The known-file workload
reads a single supplied path. The retained-input workload reads 24 distinct
files with 49,152 bytes of synthetic prior notes in the task input.

| CSV column | Meaning |
| --- | --- |
| `pair`, `workload`, `arm`, `ms` | Repetition, task, policy, total wall time in milliseconds |
| `requests`, `calls` | Scripted provider requests and charged tool calls |
| `states` | Submissions of a complete thread state to the production artifact store, counted at its API boundary |
| `scanned`, `bytesRead` | File inspections and bytes returned to the search implementation, summed across search receipts |
| `tree` | Git tree published after independent checks, compared across arms for the same task |

As a separate smoke check, both revisions were compiled with Bun 1.4.2
using the same frozen dependency tree. The existing headless CLI edit replay
passed once per binary. Both independently verified edits had patch SHA-256
`2cb37ecc648f98ba4439f41190a385ebf1147f70163b9ff778dd4b382eb14a81`.
The CLI smoke trials are separate from the 42 Swarm trials.

All five repository regression gates exited successfully. The Foundry gate
passed 914 tests, Swarm 567, commands 275, and resilience 183 Node tests plus
62 Python tests. These suites overlap. The correctness gate passed 533 Node
tests and skipped one platform-specific case. Its Python runs passed 40/45
terminal and correctness cases and 62/62 research-job cases. The five tmux
cases require Unix sockets. A dedicated rerun with tmux 3.5a installed
confirmed the runner denies socket creation. The two file-suggestion tests also
passed under Bun. The transaction-fault and old-profile replay cases run in
the normal Foundry and Swarm gates.

To reproduce the repository inventory, run the following from the candidate
checkout with the same sibling worktrees and ripgrep 15.2.0. Both views use
the parent manifest so that new runtime files do not change the denominator.
File sizes describe the search inventory. The task measurements above use
actual byte counts reported by the search operation.

~~~python
from pathlib import Path
from subprocess import check_output

parent = Path("../future-discovery-parent")
records = check_output(["git", "ls-tree", "-rlz", "HEAD"], cwd=parent)
sizes = {}
for entry in records.split(b"\0"):
    if entry:
        meta, name = entry.split(b"\t", 1)
        sizes[name] = int(meta.split()[-1])
for checkout in (parent, Path(".")):
    paths = check_output(["rg", "--files", "--hidden", "-0", "-g", "!.git"], cwd=checkout)
    visible = set(paths.split(b"\0")) & sizes.keys()
    print(len(visible), sum(sizes[p] for p in visible),
          sum(p.startswith(b"src/") for p in visible))
~~~
