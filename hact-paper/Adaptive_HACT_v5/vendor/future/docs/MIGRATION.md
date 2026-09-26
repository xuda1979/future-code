# Upgrade the companion from 1.1.0 to 1.2.0

1. Stop the 1.1 daemon and confirm that no gate process or prepared integration remains
   unreconciled. Back up the entire project, including `.future-code/`. For an online
   database use SQLite's backup API; do not copy only a live `state.db` while ignoring WAL.
2. Install 1.2 in a separate virtual environment. Run the scripted examples in new empty
   directories before opening valuable state. Keep the old environment and backup.
3. A writable Store open performs the additive schema-one to schema-two migration:
   task working memory, context audit records and supporting indexes. Existing tasks,
   evidence and events are preserved. The regression suite tests this migration.
4. Existing configuration receives the new defaults. Review them explicitly, especially
   the 16384-byte input ceiling, eight-child lifetime limit and per-cell limit. A saved
   graph exceeding the new ownership/depth rules fails closed before model calls;
   reconcile it rather than weakening acceptance checks. An old checkpoint's cursor
   cannot silently skip messages: schema-two durable delivery state is authoritative.
5. Consumers of `status.json` must accept report schema two and its three new tables.
   Read-only status can inspect a legacy database without migrating it. Start one daemon,
   run a small real-provider acceptance task, then increase concurrency under budget.

Do not downgrade a schema-two database into 1.1. Restore the pre-upgrade project/control
backup for rollback, after preserving any newly integrated source separately. Migration
and Python execution were tested on Linux only; target-host verification remains required.
No remote deployment or your hosted endpoint was exercised by this release.

---

# Original archive, compatibility and migration

## What was actually available

The uploaded `future-code-V1.0-src.zip` is 262,014 bytes with SHA-256:

`aaacb2ffcdf3be6c767112e81610643cef9eba6a88e33445de5f04db306d9a9d`

Its central directory/end record is absent. Sequential local-header recovery validated
CRC32 and uncompressed sizes for 76 complete entries: 64 regular files and 12 directories.
The next entry, `src/ink/render-to-screen.ts`, is truncated. The original `src/main.tsx`
entrypoint, execution engine, tool implementations and orchestration code were not among
the recovered files. Recovery cannot prove that every other missing file was ever present
in the bytes received. See the per-entry report in `provenance/recovery.json`.

The original archive is left untouched. No missing TypeScript modules were invented,
no original executable was fabricated, and no original build/integration test is claimed.
Unused original fragments, cached logs and the original `deepseek.env` credential file
are not redistributed in this clean source package. Per-entry hashes are provenance,
not exposed credential values. No credential from that file was used.

## Migration choices

1. **HTTP mode (recommended first acceptance route).** Run this companion against an
   OpenAI-compatible chat endpoint you operate or are authorized to use. This does not
   require the unavailable original application, its proxy or its UI. Configure exact
   URL, model ID, credentials and meaningful project gates. Compatibility with your real
   endpoint is UNKNOWN until a canary passes.
2. **Installed CLI mode (explicit opt-in).** Keep an independently installed working
   Future Code CLI. The command backend either consumes its JSON action output directly
   or uses `future-cli-bridge` to convert the control-plane message array into a plain
   prompt. Flags and output envelope must match the binary you actually have.

The bridge supports stdin or appended prompt-argument input and expects one JSON action
or a JSON object with a `result` string containing that action. It rejects banners,
markdown, malformed JSON, truncated output and nonzero/timeout exits. It does not recreate
missing CLI tools or guarantee the binary can obey the action contract. Existing CLI
integration was exercised only against controlled subprocess fixtures, not the missing
original executable.

## Example command-mode configuration

`examples/command-config.json` contains placeholders that must be replaced with installed
absolute paths. The example assumes the binary accepts `--print` followed by a prompt;
verify its actual help/behavior before use. The wrapper in the recovered source documents
`--print`, but the underlying executable and flags were unavailable for testing. Prefer
stdin mode to avoid prompt content appearing in process listings when supported.

The bridge and original CLI run inside the task workspace. Only explicitly allowlisted
environment variables reach them. Use the outer sandbox: an existing CLI may execute
arbitrary tools beyond this companion's native tool set. The scope verifier prevents
unauthorized publication, not every host-side effect of a trusted configured executable.
After an interrupted CLI call, automatic replay is blocked pending operator inspection.

## Adoption order

Keep the old installation untouched. Install this companion in a separate virtual
environment, run its deterministic local demo, then run a very small real-provider
read-only task. Add one narrow write task with an immutable acceptance test. Confirm
usage limits, output protocol, cancellation, endpoint failure/recovery and restoration
of a backup on your target host before expanding concurrency.

The interface does not preserve the original terminal UI, internal model state, tools,
remote connection manager or source build. Direct integration into that application
requires a complete, authorized source tree and its buildable dependencies. This release
supplies a tested control-plane implementation and defined adapter boundary, not evidence
that such direct integration has already occurred.
