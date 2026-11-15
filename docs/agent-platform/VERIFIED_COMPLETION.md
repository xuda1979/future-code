# Complete finite tasks from fresh verification

An explicitly configured Swarm profile can avoid requesting another model
acknowledgment after the task's outcomes are already independently verifiable.
This is useful for finite engineering tasks with complete, inexpensive checks.
It does not change the legacy terminal `/goal` completion protocol.

Add this property to an existing pinned agent profile:

```json
{
  "completionPolicy": "verified-checks"
}
```

The profile must already permit `run_check` and declare its named `checks`.
Keep all task acceptance conditions, immutable verifier checks, negative
controls, write scopes, budgets and integration checks. The policy is off when
the property is absent. Configure it before pinning a new run; editing a spec
does not upgrade an existing pinned session.

At a complete tool boundary, the host requires current successful owned
receipts for every profile check and changed source, job or child evidence.
Saved replies and admitted tool calls drain first. The host then runs the
**full independent task verifier** on the exact candidate. A complete current
PASS can produce the ordinary candidate descriptor without another model
request. The scheduler still verifies that descriptor freshly, and integration
still rebuilds its own checks.

A missing, stale, failed or unknown result continues the same attempt. A
durable UNKNOWN probe intent prevents a restart or new feedback from repeatedly
probing unchanged material. Source changes, cancellation and lease expiry are
checked across asynchronous verification boundaries. Model claims cannot
authorize completion.

This policy adds a full verification pass. Enable it only when that cost is
worth avoiding a model round trip and the pinned contract covers every desired
outcome. Tasks requiring a human-readable analysis still need that output in
their acceptance contract. Operations, programme and theory authorities retain
the ordinary completion path because they have additional mutable evidence.
No model, reasoning effort, permission or domain policy changes.

The focused production integration tests cover rejection, negative controls,
saved replies, later tool mutations, stale/unowned receipts, cancellation,
lease expiry, budgets and crash recovery:

```sh
node --experimental-strip-types --test tests/foundry/verified-completion.test.ts
```

Live component measurements and their limits are recorded separately under
`experiments/verified-completion-20261115/`. They do not certify a packaged CLI,
an installed running session, or a speedup for arbitrary research projects.
