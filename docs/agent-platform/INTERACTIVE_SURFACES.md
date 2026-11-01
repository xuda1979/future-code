# Verified interactive surfaces

Future-Code has an opt-in Display/HID subsystem in `src/harness/surface/`.
The kernel defines observations, physical input verbs, predicate guards,
state-delta receipts, one-owner leases, replay rules and human interrupts.
The optional `adapters/surface/` driver supplies Playwright-specific browser
observation and input. Other browser/desktop engines implement the same
`InteractiveSurfaceDriver` interface. Kernel code contains no CSS/XPath,
website workflow, browser-engine import or project knowledge.

## Execution contract

`SceneFrame` contains a bounded visible affordance/landmark tree, viewport and
scroll geometry, center-point occlusion checks, a document identity and ephemeral
integer marks. Open shadow roots are observed. The driver scans at most 12,000
elements and emits at most 160 visible nodes; `truncated` explicitly reports an
incomplete scene. A requested Set-of-Mark screenshot is a private SVG artifact
containing a viewport image and numbered boxes. Image bytes and raw HTML never
enter the model's text context.

Every action supplies `expectedFrameId`. Every microstep supplies a nonempty
postcondition. All marks in a batch refer to that initial frame. The host rebinds
them to the same driver-owned object identity after each step. A removed object,
navigation, changed label/layout or stale caller frame stops dispatch. Reused
integer marks cannot redirect an earlier target to a different control.

The Playwright adapter sends mouse/keyboard input rather than `element.click()`.
It waits for two animation frames, at least 150 ms of DOM/layout stability and
tracked document/XHR/fetch completion, subject to a deadline. A stable page whose
predicate is still false is polled for delayed state until that same deadline.
Persistent connections cannot cause an unlimited network-idle wait. Each batch
has at most 16 steps and a declared settling/typing budget of at most 9 seconds;
split longer procedures into newly observed batches.

Receipts report semantic node, focus/navigation and layout changes, bounded
network status/method/type metadata, and cookie/localStorage/sessionStorage
change indicators. Set `measureVisual: true` for viewport and target pixel-diff
ratios. Unmeasured/unavailable channels are `null`, never fabricated zeros.
Pixel motion, analytics traffic or adapter process exit zero cannot satisfy a
semantic postcondition. An already-satisfied idempotent predicate may succeed.
`SILENT_NO_OP` means the requested predicate was falsified with no observed
change; it does not prove that an external server received no request.

A failed guard, timeout or occlusion aborts the batch suffix. The sole local
reflex is a pre-dispatch scroll followed by a fresh hit test. The host never
re-clicks a dispatched action, force-clicks through an overlay, dismisses a
cookie/consent banner, or retries an uncertain form submission automatically.
Successful role/name/verb/timing observations are cached as session-scoped
affordance notes in runtime memory. These are hints, not executable policy.

## Session, memory and recovery

One resident process owns a persistent browser profile and a serialized surface
controller. Cookies, IndexedDB and localStorage remain in that profile between
tool calls and normal host restarts. Browser/profile state is not copied into
model context. Keep it under a private `.future-code/` directory.
Session cookies also receive a private cookie snapshot on normal shutdown;
Chromium may otherwise discard them. Session/profile/origin bindings cannot be
changed within an existing state directory. These credentials never enter the
evidence journal.

The private SQLite journal uses WAL and synchronous FULL writes. A stable action
identity and input digest are recorded before effects. Completed duplicates
return the stored receipt; changed input under the same identity is rejected.
A crash after intent without a receipt is `UNKNOWN` and raises an intervention.
The host never replays that action. A stale host lock requires the operator to
verify the previous process has exited before removing it.

Only the latest full frame and its compact structural delta are hot. Replaced
frames immediately enter cold `EPHEMERAL_SURFACE_STATE` episodes. Swarm receipt
projection also retires older spatial frames before ordinary token-pressure
retirement, retaining complete call/result pairs and owned recall references.
This is a runtime extension; the frozen context-retirement v2 research protocol
and historical experimental cohorts remain unchanged.

CAPTCHA/authentication hints, password/one-time-code inputs, native JavaScript
dialogs and explicit `data-surface-blocker` declarations raise
`SIG_SURFACE_INTERVENTION`. The lease's liveness clock pauses and the interrupt
persists even if the gate disappears. Swarm defers the pending capability rather
than asking the model for more clicks. Existing task continuation releases the
execution slot and its no-progress timer; inspection waits use no model turns.
Other independent tasks can continue through the existing scheduler.

The operator uses the same headed browser and can request fresh annotated
viewport artifacts through `surface_observe` with `includeVisual: true`.
Native dialogs appear in that browser. Explicit operator acknowledgement is
required after the barrier is handled; the post-intervention transition is
recorded in intervention memory. This release exposes snapshots and a live
headed browser, not a remotely hosted viewport streaming/remote-control UI.

## Start a surface host

Use Node >=22.13 for this optional host, matching Foundry's `node:sqlite`
runtime. Install current Playwright and `pngjs` in an isolated directory or in
`adapters/surface/`, and install the corresponding Chromium. The main CLI does
not gain a mandatory browser dependency. The browser CI pins an isolated
Playwright version solely for reproducible local fixture tests.

Create a private host config, for example
`.future-code/surface/host.json`:

```json
{
  "root": ".future-code/surface/state",
  "profile": ".future-code/surface/profile",
  "sessionId": "operator-session",
  "startUri": "https://your-authorized-site.example/",
  "allowedOrigins": ["https://your-authorized-site.example"],
  "port": 8754,
  "headless": false,
  "measureVisual": true
}
```

Set distinct, random `SURFACE_TOKEN` and `SURFACE_OPERATOR_TOKEN` environment
secrets of at least 24 characters. The worker gets only `SURFACE_TOKEN` and
`SURFACE_ENDPOINT=http://127.0.0.1:8754/`. The operator token is never granted to
model tools. Start the resident host separately:

```sh
node --experimental-strip-types adapters/surface/server.ts --config .future-code/surface/host.json
node --experimental-strip-types adapters/surface/capabilities.ts operator-session
```

The second command prints the `operations` policy fragment. Put it into the
project's Swarm spec and grant only the relevant agent:

```json
{
  "tools": ["invoke_capability", "read_operations", "recall"],
  "capabilities": ["surface_observe", "surface_act"]
}
```

The generated adapter declaration pins its implementation files and inherits
only the two worker environment names. Adjust project budgets and independently
pinned acceptance checks for the authorized task. Existing capability admission,
external action reconciliation and immutable acceptance checks continue to
apply. HTTP request routing filters configured origins and blocks service
workers; it is not a network sandbox or permission to perform every transaction
on an allowed origin. Site-specific authority/confirmation policies belong in
the project adapter/configuration.

First call `surface_observe` with `{ "sessionId": "operator-session" }`.
Use returned marks to call `surface_act`, for example:

```json
{
  "sessionId": "operator-session",
  "transitionId": "search-query-1",
  "expectedFrameId": "FRAME_FROM_OBSERVATION",
  "steps": [
    { "action": { "kind": "activate", "markId": 12 }, "expect": { "targetFocused": 12 } },
    { "action": { "kind": "input", "markId": 12, "text": "query", "clearFirst": true }, "expect": { "targetValue": { "markId": 12, "equals": "query" } } },
    { "action": { "kind": "activate", "markId": 15 }, "expect": { "uriChanged": true } }
  ]
}
```

`transitionId` identifies one intended interaction, not an arbitrary retry
counter. Reusing it with a different frame/payload is rejected. An uncertain
effect requires inspection and operator reconciliation before a replacement.
Newly mounted controls need a new observation and batch.

Human endpoints are authenticated POST requests to the loopback host:

| Endpoint | Operator JSON | Effect |
| --- | --- | --- |
| `/dialog` | `{ "interruptId": "CURRENT_ID", "accept": false }` | Explicitly dismiss/accept the pending native dialog; returns a fresh observation. |
| `/resume` | `{ "interruptId": "CURRENT_ID", "expectedFrameId": "LATEST_FRAME" }` | Reobserve, require the gate to be gone, record the transition and release the wait. |
| `/reconcile` | `{ "key": "ACTION_KEY", "batch": ORIGINAL_BATCH, "interruptId": "CURRENT_ID", "expectedFrameId": "LATEST_FRAME" }` | After reviewing an uncertain external effect, record `OPERATOR_RECONCILED` with `ok: false`. Never replays the action or certifies its intended outcome. |

Use `Authorization: Bearer <SURFACE_OPERATOR_TOKEN>`. The worker token cannot
call these endpoints. Unknown dispatched effects and settling timeouts require
`/reconcile`; `/resume` alone cannot release that uncertainty. The interrupted batch's suffix is never resumed blindly;
after handoff its failed receipt and fresh frame return to deliberation.

## Validation and current boundary

```sh
node scripts/test-surfaces.mjs
node scripts/test-surfaces.mjs --browser
node --experimental-strip-types --test tests/foundry/surface.test.ts
```

Pure tests exercise stale IDs, remapping, silent no-ops, false network/pixel
progress, bounded waits, serialized callers, durable replay, interrupted intent,
operator authentication and handoff reconciliation. Chromium fixtures exercise
actual mouse/keyboard input, delayed DOM changes, an invisible overlay, open
shadow DOM, storage/network/pixel receipts, annotated screenshots, navigation,
native dialogs, secret redaction and persistent session restart.
An intentionally frozen renderer also verifies that observations fail with a
bounded `SURFACE_DRIVER_TIMEOUT` instead of leaving a silent tool hang.

Browser tests require installed Playwright/Chromium and `pngjs`; they fail rather
than silently skipping missing dependencies. `SURFACE_BROWSER_EXECUTABLE` can
select an already-installed compatible Chromium for these fixture tests.
Closed shadow trees, cross-origin iframe internals, complex canvas affordances,
multi-tab planning and biometric/OS dialogs need additional drivers/operator
handling. Challenge detection is conservative and incomplete. No claim of
human-equivalent success on arbitrary live websites or anti-bot systems follows
from these local tests. Surface observations do not certify the project's final
external outcome; independent acceptance checks remain mandatory.
