# OpenCode and Future Code: productivity comparison and integration

## Conclusion

Future Code should combine a direct, efficient interactive execution path with
its durable goals, recovery, and independent acceptance mechanisms. A reported
10× difference on ordinary work deserves investigation; it should not be
explained away as the cost of verification. The normal Future Code REPL does
not run an independent Foundry verifier after every action.

This investigation found and fixed actual provider-boundary defects, including
a completed response waiting for HTTP EOF, lost tool arguments, and a local
tool-choice conversion crash. They can waste time independently of GLM's
inference speed. It also adds autonomous recovery for slow decisions on a
conservative set of routine tasks, without imposing a goal lifetime limit.
It identified architectural differences requiring live
measurements before further changes. This report does **not** establish that
all causes of the user's observed 10× difference have been resolved.

## What was compared

| Evidence | Scope |
| --- | --- |
| Future Code source | Current `main` baseline `271702277bbbbd1cf3b44dbc3b6d1ab0407c4bac`, plus this PR. The measurement manifest records the executed source hashes. |
| OpenCode source | `anomalyco/opencode` commit `2cb1818d01bb8bbfdbe37f2b64436fce6328fc6a`, dated 2026-11-17. This is the current V2 tree, not an assertion about the user's installed version. |
| Executed OpenCode component | Published `@opencode/ai@2.3.0`, genuine native OpenAI-compatible transport. Exact isolated npm manifest/lock, registry integrity, and executed protocol hash are retained. |
| Executed Future Code component | Actual Python provider `Handler`, reached over HTTP, including Messages-to-Chat translation and downstream SSE. |
| Excluded from timing | Full coding CLIs, UI startup, actual GLM/Big Pickle/Sol inference, model quality, autonomous weeks-long experiments, human completion time. |

The user's OpenCode + Big Pickle versus Future Code + GLM comparison changes
both the model/service and the harness. It is a useful operational observation,
but cannot allocate the difference between them. No live provider credentials
were available in this execution environment. The local comparison uses the
same deterministic upstream for all arms; it isolates runtime behavior.

## Detailed strengths, weaknesses, and integration decisions

| Area | OpenCode: strengths and costs | Future Code: strengths and costs | Integration decision |
| --- | --- | --- | --- |
| Provider integration | Native typed Chat, Responses, Messages, and other routes normalize protocol events. Provider compatibility options handle differences such as Z.ai tool streaming. This is a substantial maintained adapter surface, with its own compatibility risks. [O1, O2] | The interactive GLM path translates Messages through a local Python Chat bridge. This preserves the existing tool/permission UI but adds a protocol boundary. This PR reproduces concrete failures there. [F1] | Adopt explicit protocol completion and lossless tool-argument handling now. A native multi-provider replacement needs its own compatibility evaluation; globally enabling unsupported API features would break routes. |
| Time to usable tool call | Native Chat uses the model's valid finish reason and `[DONE]` to emit completed calls. It does not require transport EOF. [O1, O3] | Tool execution already streams by default, but the bridge withheld tool block completion until socket EOF. That defeated the benefit on affected routes. [F1, F2] | Fixed: release the complete, validated batch at protocol completion. Preserve terminal usage and reasoning; do not infer completion merely from a JSON-looking argument fragment. |
| Independent tools | Session steps start tool fibers as calls arrive; the library also provides concurrent tool dispatch. Fast overlap is useful, but concurrent side effects still need resource and mutation coordination. [O3, O4] | Safe tools overlap; non-concurrent tools are ordering barriers. This protects context updates and dependent mutations but can serialize independent writes in the interactive loop. Foundry provides explicit task-level concurrency. [F2, F3] | Keep existing safe parallelism and mutation barriers. Improve dependency declarations with measured workloads rather than copying unbounded execution into every path. |
| Planning and prompt overhead | A short base system prompt emphasizes available tools and parallel independent calls; runtime instructions, tools, skills, and provider context add to it. A short base template does not prove a small total request. [O5] | Current instructions already keep routine read/edit/check work direct. The main loop is model → tools → model, not an obligatory planner/critic chain. More capabilities mean more potential context and configuration surfaces. [F2, F4] | Preserve the recently added direct short-task policy. Do not add a new planner, classifier, or judge call for each small action. Total request sizes remain a live measurement target. |
| Tool definitions and prefill | Native provider-specific lowering and compatibility controls make schema behavior explicit. Sending many tools can still cost context. [O1] | Third-party proxies disable provider-native deferred tool references by default. All enabled schemas can then be sent inline, increasing prefill if many MCP tools are installed. That gate prevents unsupported `tool_reference` payloads. [F5] | Keep compatibility protection. Measure enabled schema count/bytes before introducing provider-neutral discovery. Do not turn on Anthropic-specific deferred loading for GLM blindly. |
| Tool output size | Tool output handling defaults to 2,000 lines / 50 KiB and saves excess output. Smaller working context helps throughput but may require targeted rereads. [O6] | Per-tool persistence and a default 32,000-character aggregate wire-message budget preserve full outputs as references. Read/image exemptions and frozen replacement decisions preserve semantics and prefix stability. [F6] | Retain existing full evidence and reference-based budgets. The suspected separate-message bypass is already handled, including interleaved streaming fragments; no duplicate budget layer was added. |
| Compaction and long context | V2 supports recent context beside structured summaries, provider-native compaction where supported, and guarded background precomputation. Summaries are lossy; unused background work costs tokens and can contend with a slow main model. Documentation and source defaults can differ across versions. [O7] | Active goals have a 64k working-context target, durable goal/steering state, and existing compaction/restore paths. Foreground compaction can pause work; a lower target can also compact more often. [F7] | Preserve durable authority outside summaries. Background compaction is a promising separate change only with frozen source coverage, tail retention, cancellation, and resume tests; it is not enabled speculatively in this PR. |
| Model roles and effort | Configurable provider/model variants and auxiliary agent models allow role-specific effort. More configuration can make comparisons misleading unless resolved settings are captured. [O7, O8] | Helper/subagent defaults fall back to the main model. Direct binary defaults and official launcher defaults differ: the launcher selects medium effort and disables persistent retries; explicit settings win. Heavy helper use is possible, but summaries are opt-in and several other helpers are gated off. [F4, F8] | Keep user-selected model/effort and autonomy. Do not obtain a speed claim by silently reducing main-model reasoning quality. Record resolved role models in a live comparison. |
| Thinking without action | Efficient tool flow and explicit model configuration help routine work, but no harness can infer useful problem-solving progress from token activity alone. | The ordinary idle watchdog resets on thinking tokens. A model can keep thinking without reaching a tool; transport liveness alone does not detect that delay. [F11] | Added a soft 120-second model-decision target for narrowly identified routine objectives. Redirect automatically, then use an existing configured runtime fallback if available. Release the target after bounded corrections rather than pause the goal or repeatedly interrupt reasoning. |
| Retries and failures | Explicit bounded retry schedules distinguish timeouts from unreachable networks and publish retry events. Network recovery can still wait a long time by design. [O9] | Proxy attempts and client retries can multiply during failures; persistent operation is configurable. Previously, stream exceptions could also fall through to another buffered model request. [F1, F8] | Fixed hidden post-stream fallback. One bridge attempt owns its stream; after emission starts, failure is explicit, with no second buffered generation. Existing higher-level recovery remains available. |
| Broken or truncated tools | Native parser rejects incomplete streams by default and does not confirm tools after truncation/content filtering. [O1, O4] | Previous bridge behavior could discard pre-name arguments, invent the first available tool, and finish a broken stream as success. That creates wrong work or repair turns. [F1] | Fixed: preserve fragments; infer a missing name only when exactly one tool was offered; validate the entire batch before tool completion; reject incomplete, malformed, ambiguous, or filtered tool output. |
| Durable work and verification | OpenCode persists session/tool settlement, handles interruption, captures snapshots, and supports jobs and automation. It should not be described as merely a stateless chat loop. [O3] | Foundry adds immutable acceptance, scoped tasks, durable scheduling/fencing, independent Swarm verification, and remote-job/checkpoint recovery. These are useful for research where a plausible answer is not a valid result. They carry coordination cost when used unnecessarily. [F3, F9] | Keep acceptance and recovery. Use concrete checkpoints and evidence for long work; keep ordinary interactive actions direct. Session persistence alone is not proof that a research objective passed. |
| Autonomy | Permissions and agent behavior are configurable; interactive modes may request decisions. Efficient execution still depends on the selected policy. | Existing default unattended execution suppresses question/plan dialogs, continues durable goals, and preserves explicit operator constraints. A goal has no default lifetime continuation cap. [F10] | Preserved. No new permission/confirmation prompts, manual recovery step, global reasoning-effort reduction, token cap, or goal lifetime cap is introduced. Failures remain machine-visible so the autonomous owner can recover without fabricated success. |

## Changes implemented in this PR

1. Stop the upstream reader at SSE `[DONE]`, including optional whitespace and
   CRLF variants. Do not perform another blocking read after model completion.
2. Translate dictionary-shaped `tool_choice` values without the unhashable-dict
   exception. Preserve supported forced/automatic choices.
3. Buffer fragmented arguments even when the provider sends them before a tool
   name. Preserve parallel calls and their arguments exactly.
4. Finalize tools only after a valid completion and validation of the entire
   batch. A single offered tool can resolve a missing name; several cannot.
5. Return an explicit stream error for malformed, failed, or truncated output.
   Do not replay a started stream through a second buffered generation. Release
   blocked urllib readers on early failure/cancellation before closing them.
6. Recover slow routine model decisions automatically. This has no extra
   classifier/model call on the normal path. Eligibility requires both the
   active short goal and latest human instruction to match complete routine
   imperatives, such as `replace "old" with "new" in src/app.ts` or `run npm test`.
   Unknown work, research, proofs, mixed objectives, children and background
   tasks do not opt in merely because their prompts are short.

The routine recovery first retries with a direct-action reminder, preserving
the original effort and tool/verification policy. If it remains slow, an
explicitly configured fallback uses the existing runtime model-switch behavior,
including signature handling and tool followups; saved model settings are not
changed. Without a usable fallback, or after its bounded correction, normal
reasoning continues without that routine deadline. A changed goal, steering,
horizon, queued human input, or operator cancellation invalidates stale policy.
Admitted tools are collected once and may run longer than the model target.
The existing stricter Git-delivery policy keeps precedence.

`FUTURE_CODE_ROUTINE_MODEL_TIMEOUT_MS` can override the default 120,000 ms;
`0` disables this optional recovery target. It is a **soft recovery threshold**,
not a promise that an arbitrary task finishes in two or ten minutes. Releasing
the guard after bounded corrections preserves autonomy and necessary reasoning
when a configured alternate model is unavailable. There is no new goal token
or lifetime limit.

A further configuration gap matters when interpreting GLM timings: the bridge
currently translates `output_config.effort` into upstream reasoning fields only
on its GLM-5.2-specific route. A GLM-5.3 client-side effort setting therefore
does not prove that the upstream received or honored it. Some gateways reject
these fields, so this PR does not blindly add them to every endpoint or assume
that the provider's omitted-field default is maximum reasoning.

These apply to every affected provider turn, so they matter for a one-file edit
and for repeated turns inside a weeks-long project. A repeated local sequence
is not a weeks-long experiment, however, and no such productivity claim is made.

## Controlled comparison

See [raw samples and authenticated inputs](validation/provider-terminal-20261117.json).
Each arm receives identical generated reasoning, tool arguments, terminal usage,
and a `[DONE]` marker. The upstream then keeps HTTP open for a controlled 200 ms.
An immediate-EOF scenario is the guardrail. Every returned call drives the same
local file read, with identical output hashes across all arms.

Five samples per arm, rotating execution order. Each trial has one successful
warmup request excluded from steady-state totals and starts a fresh measured
conversation. Warmup timings are retained; they measure first-request setup,
not process startup or module import time. The 12-turn case measures sequential
provider/tool handoffs with growing history. Actual upstream counts include
warmup and must equal measured rounds + 1, with no hidden retry.

| Measured steady-state scenario | Previous Future Code | Updated Future Code | OpenCode native provider library |
| --- | ---: | ---: | ---: |
| One tool turn, controlled 200 ms post-completion hold | 205.07 ms | 3.75 ms | 12.69 ms |
| Twelve turns, same hold on each response | 2,501.56 ms | 51.05 ms | 155.37 ms |
| Immediate transport EOF, one turn | 3.76 ms | 3.21 ms | 12.90 ms |

These are medians of five samples, not live-provider latencies. Both updated
Future Code and OpenCode avoid the idle transport tail. The final comparison
ran after regression suites finished to reduce CPU contention. Millisecond
differences in the immediate-EOF case do not establish a meaningful speed win;
earlier contended development runs showed several milliseconds of variation.
Different runtime setup costs also remain relevant at this scale.

This experiment cannot rank the full OpenCode and Future Code products. It does
not measure model prefill/generation, problem-solving ability, prompt-induced
extra turns, UI overhead, or independent task acceptance. OpenCode's native
library and Future Code's complete bridge are different components. Their
latencies are reported openly, not relabeled as completed coding-task scores.

## Validation and next measurement

Twelve new regressions exercise the actual bridge and loopback HTTP path,
plus translation units. They cover terminal-marker release, valid EOF,
interleaved/pre-name arguments, structured choices, malformed/error payloads,
truncation, no replay, and held-open reader cleanup. Seven routine-decision
regressions execute the extracted production request/watch/recovery boundary
with the actual stream watchdog and tool executor, isolating UI/API adapters.
Scaled timing tests preserve effort/permissions, a slow admitted tool's one
receipt, configured fallback, exhausted-correction continuation, deep work,
opt-out, changed authority, queued work and cancellation. These are boundary
tests, not full compiled CLI or live-model quality certification. Existing autonomy,
verification, recovery, and command suites are run independently.

Exact commands, source hashes, gate results, environment-dependent skips and
the resolved integration-test failure are retained in the
[validation record](validation/provider-efficiency-validation-20261117.json).
The existing goal-context assertions were preserved, not weakened to pass.
All required local gates passed: correctness, resilience, the 899-test Foundry
suite with test files serialized, the 557-test Swarm suite, 242 command tests,
query transpilation, and 38 API retry/authentication/model-configuration tests.
The earlier parallel Foundry timing-label failure is retained in the record;
no production checks, assertions, or deadlines were relaxed. Optional tmux,
platform-feedback, and real Icarus RTL checks unavailable here are identified
separately.

## Product target across short, medium, and long tasks

The target is stronger performance across all three task classes while retaining
correctness and autonomy. A global "best agent" claim remains unmeasured.
Task complexity and dependency structure matter more than a guessed duration:

| Task class | Representative workload | Advantages to integrate | Advantages to retain | Required outcome evidence |
| --- | --- | --- | --- | --- |
| Short | Literal config/file change, narrow diagnosis, tested local Git delivery; minutes to hours in the user's workflow | Direct tool flow, low request overhead, lean working context, prompt model-decision recovery | Permission/authority boundaries, targeted tests, actual delivery receipts, autonomous completion | Independent task check; verified completion time and success rate; first useful action; calls/tokens/cost; no manual interventions hidden |
| Medium | A feature or bug fix across modules, dependencies, and integration tests | Independent read/research overlap, selective delegation, relevant tools/context, role-specific model configuration | Dependency ordering, mutation coordination, regression coverage, explicit acceptance | Correct integrated artifact; total time including validation/rework; success rate, cost and interventions on the same frozen tasks |
| Long | Multi-stage research, remote training/evaluation, experiments with interruption and resume; days to weeks | Efficient provider adapters and context, guarded checkpoint/summary reuse, event-driven coordination, useful parallel work | Durable objective/steering, independent evidence, immutable acceptance, checkpoint lineage, job supervision and recovery | Actual research objective/artifact and guardrail results, not task counts; valid resume, downtime, replay/duplicate effects, verified progress per total wall time and resource cost |

For each class, compare previous Future Code, candidate Future Code, OpenCode,
and Codex where the relevant runtime and model access are available. Use a
matched-model comparison to isolate the harness, and a separate best-configured
product comparison to assess what a user actually experiences. Pin versions,
instructions, tools, inputs and independent checkers; use fresh workspaces and
repeated trials with rotated order. Include timeouts and failures.

A speed improvement counts only when the required artifact passes the same
independent acceptance check. Reducing verification, silently weakening effort,
stopping early, or reporting activity as success cannot establish a win.
Current local component results are **measured**; live short/medium coding and
weeks-long product rankings are **not measured**. The existing coding comparison
harness and remote-job tests provide starting instruments, not completed
evidence for a world ranking.

To allocate the user's real speed gap, run the existing
[`compare-agent-productivity.mjs`](../../scripts/compare-agent-productivity.mjs)
on the same repository tasks with independent checks. First run both harnesses
against the **same model, endpoint, effort, tool access, and frozen inputs**.
Then run the user's preferred OpenCode/Big Pickle and Future Code/GLM settings
as a separate operational comparison. Include a configuration edit, narrow bug
fix, cross-file change, tested Git delivery, and a resumable experiment.
Record time to first useful tool, verified completion, model calls, input/output
and reasoning tokens, retries, compaction time, tool time, failures, and human
interventions. Keep failed runs in the denominator. No live scores are invented
here, and no permission/autonomy setting is loosened to create a faster result.

## Reproduce the local measurements

```sh
git worktree add --detach ../future-code-baseline 2717022
npm ci --prefix experiments/provider-comparison-20261117/opencode-runtime --ignore-scripts --no-audit --no-fund
python3 scripts/bench-provider-terminal.py ../future-code-baseline --samples 5 --hold-ms 200 \
  --opencode-runtime experiments/provider-comparison-20261117/opencode-runtime \
  --output docs/agent-platform/validation/provider-terminal-20261117.json
python3 -m unittest discover -s tests/correctness -p test_provider_stream_completion.py -v
node --experimental-strip-types --test tests/correctness/routine-decision-policy.test.ts
node scripts/test-correctness.mjs
node scripts/test-resilience.mjs
node scripts/test-foundry.mjs
node scripts/test-swarm.mjs
node scripts/test-commands.mjs
```

The optional npm installation belongs only to this isolated benchmark prefix;
Future Code's production dependencies are unchanged. Omitting
`--opencode-runtime` runs the baseline/candidate comparison without npm.
To apply the runtime changes after merge, rebuild the agent using the normal
[build process](../../build.sh) and update the installed Python proxy too.
Already running sessions and installed older binaries do not acquire these
changes from a repository pull alone. This PR does not deploy to the user's
machine.

## Source references

OpenCode references below are pinned to the inspected revision, rather than
assuming the user's installed version matches a changing website.

- **O1:** [native Chat request/stream state machine](https://github.com/anomalyco/opencode/blob/2cb1818d01bb8bbfdbe37f2b64436fce6328fc6a/packages/ai/src/protocols/openai-chat.ts), especially `fromRequest`, tool finalization, and `protocol.stream.terminal`.
- **O2:** [OpenAI-compatible route](https://github.com/anomalyco/opencode/blob/2cb1818d01bb8bbfdbe37f2b64436fce6328fc6a/packages/ai/src/protocols/openai-compatible-chat.ts).
- **O3:** [session step execution and durable settlement](https://github.com/anomalyco/opencode/blob/2cb1818d01bb8bbfdbe37f2b64436fce6328fc6a/packages/core/src/session/runner/step.ts).
- **O4:** [tool runtime](https://github.com/anomalyco/opencode/blob/2cb1818d01bb8bbfdbe37f2b64436fce6328fc6a/packages/ai/src/tool-runtime.ts) and [tool-loop continuation](https://github.com/anomalyco/opencode/blob/2cb1818d01bb8bbfdbe37f2b64436fce6328fc6a/packages/ai/src/loop.ts).
- **O5:** [base prompt](https://github.com/anomalyco/opencode/blob/2cb1818d01bb8bbfdbe37f2b64436fce6328fc6a/packages/core/src/session/runner/prompt/system.txt) and [conditional tool guidance](https://github.com/anomalyco/opencode/blob/2cb1818d01bb8bbfdbe37f2b64436fce6328fc6a/packages/core/src/session/system-prompt.ts).
- **O6:** [retained tool output limits](https://github.com/anomalyco/opencode/blob/2cb1818d01bb8bbfdbe37f2b64436fce6328fc6a/packages/core/src/tool-output.ts).
- **O7:** [compaction implementation](https://github.com/anomalyco/opencode/blob/2cb1818d01bb8bbfdbe37f2b64436fce6328fc6a/packages/core/src/session/compaction.ts), [compaction documentation](https://opencode.ai/docs/compaction/).
- **O8:** [model and variant documentation](https://opencode.ai/docs/models/).
- **O9:** [retry ownership and bounded policies](https://github.com/anomalyco/opencode/blob/2cb1818d01bb8bbfdbe37f2b64436fce6328fc6a/packages/core/src/model-retry.ts).
- **F1:** [provider bridge](../../future_huanxin_future_proxy.py).
- **F2:** [main query](../../src/query.ts), [query defaults](../../src/query/config.ts), [streaming tool executor](../../src/services/tools/StreamingToolExecutor.ts).
- **F3:** [Foundry scheduler](../../src/harness/foundry/scheduler.ts), [store](../../src/harness/foundry/store.ts).
- **F4:** [system instructions](../../src/constants/prompts.ts), [optional summaries](../../src/services/toolUseSummary/toolUseSummaryGenerator.ts).
- **F5:** [tool-search capability gate](../../src/utils/toolSearch.ts), [API schema construction](../../src/services/api/future.ts).
- **F6:** [persisted outputs and wire-message grouping](../../src/utils/toolResultStorage.ts), [budget policy](../../src/utils/toolResultBudgetPolicy.ts).
- **F7:** [working context policy](../../src/services/compact/workingContextPolicy.ts), [compaction](../../src/services/compact/autoCompact.ts), [durable goal authority](../../src/commands/goal/auto.ts).
- **F8:** [launcher defaults](../../future-code.sh), [binary defaults](../../src/entrypoints/cli-bundle.ts), [client retry layer](../../src/services/api/withRetry.ts).
- **F9:** [independent Swarm verification](../../src/harness/foundry/swarm/verification.ts), [remote job supervision](../../scripts/research_job_supervision.py).
- **F10:** [autonomy regressions](../../tests/correctness/direct-execution.test.ts).
- **F11:** [stream liveness](../../src/utils/modelStreamLiveness.ts), [routine decision policy](../../src/utils/routineDecisionPolicy.ts), [recovery boundary regressions](../../tests/correctness/routine-decision-policy.test.ts).

OpenAI's [published Codex agent-loop explanation](https://openai.com/index/unrolling-the-codex-agent-loop/)
also supports stable prompt prefixes and context management as harness concerns.
This report uses that public guidance; it does not claim access to proprietary
GPT-6.1 Sol Max internals or claim that a harness change equalizes model ability.
