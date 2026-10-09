# Durable R&D Operations (experimental)

This operational plane is project-agnostic. It supplements Foundry/Swarm, not a competing task scheduler.
Stored state lives at \`<project>/.future-code/ops/\`. Do not commit generated state or tokens.
Operator config lives at \`.future-code/ops/config.json\`.

## Configuration
\`\`\`json
{
  "schema": 1,
  "executors": {
    "lab": {
      "url": "http://127.0.0.1:9000/exec",
      "maxConcurrent": 3,
      "tokenEnv": "LAB_EXEC_TOKEN",
      "idempotencyKeys": false
    }
  },
  "watchers": [
    {
      "id": "health",
      "box": "lab",
      "command": "cat /tmp/health.json",
      "pattern": "exception|failed",
      "pollMs": 30000
    }
  ]
}
\`\`\`

## Compiled CLI
\`\`\`sh
./future-code --ops exec lab 'uname -a'
./future-code --ops fanout requests.json
./future-code --ops task '{"id":"experiment-1","status":"running","goal":"Validate baseline","argv":["python","run.py"]}'
./future-code --ops state
./future-code --ops compact
./future-code --ops decision '{"id":"decision-1","question":"Approve replacement hardware?"}'
./future-code --ops answer decision-1 'No'
./future-code --ops evidence '{"claim":"Baseline verified","file":"results/summary.json","verdict":"PASS"}'
./future-code --ops verify EVIDENCE_ID
./future-code --ops watch-once
./future-code --ops supervise
\`\`\`

A separate long-lived service manager (launchd/systemd/Kubernetes) must keep \`--ops supervise\` resident. Session exit must not be relied on as a daemon. The supervisor is condition-triggered, and the persisted armed state prevents repeated recovery triggers. Watcher recovery actions require \`auto: true\`, a configured executor declaring \`idempotencyKeys: true\`, and server-enforced deduplication; otherwise the trigger requires operator action. Network errors and timeout outcomes are UNKNOWN, never successful. Changing a claim needs a new evidence entry; evidence verification reads current file bytes and detects drift. The state projection retains pending task commands, last errors and decisions across compaction, but injecting it into every conversational compaction path is follow-up work.

## Scope and known limitations
- This MVP exposes remote execution as a dedicated \`--ops\` CLI, not yet an LLM-callable permissioned tool. Do not infer model tool-call productivity improvement from this addition alone.
- Remote connections use HTTP keep-alive where supported by the runtime; the server must implement its own transport resilience. Fanout executes concurrently subject to each local box's concurrency cap.
- Persistent watchers currently evaluate configured remote responses. Named background-job log streaming, async notifications, target-specific packaged binaries, audit chain verification, and multi-host leader election remain follow-up requirements.
- Never enable automatic recovery for irreversible commands without audited, server-enforced idempotency and explicit operator policy.
- Initial deployment requires \`rg\` on PATH for plain compiled binaries unless the build genuinely embeds the rg applet and \`FUTURE_EMBEDDED_RIPGREP=true\` is set.
