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
