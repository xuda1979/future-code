# Engineering changes after confirmation-plan freeze

The advisory priority algorithm (`impact.py`), frontier optimizer (`frontier.py`),
training data, and serialized tree plans are unchanged. Confirmation outcomes
were not available when the following changes were made:

- Bind replay evidence to a complete frozen source manifest, plus checker and
  environment fingerprints, instead of the earlier single changed-file label.
- Add a generic strict pytest CLI with protected acceptance inputs and explicit
  identity/timeout checks.
- Harden the epoch guard: exact delivery retries are idempotent; conflicting
  same-epoch results revoke authorization and require a fresh epoch. A prior
  FAIL cannot be overwritten into PASS by a later delivery.

These are correctness improvements, not retuning of the learned policy. Both
pilot and confirmation certificate measurements use this strengthened code.
