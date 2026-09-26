# Operating the v4 evidence layer

## Choose the consumer before optimizing

For ordinary status, render `status_prompt` from a trusted gate report. Do not send
all internal certificate packets to the root model. This interface does not change
when the display tree changes. It is already small without a learned tree.

For diagnosis, use `diagnostic_pages(packets, budget=16384)`. Each page preserves
whole compact packets; a packet that cannot fit is rejected rather than truncated.
The budget is UTF-8 bytes. Model-side tokenizer and chat framing budgets must be
checked separately before sending a request. No provider is called by this helper.

For log export, use `encode_wire`. Modes are padded records, canonical records,
independently compressed packets, and whole-epoch compression. Only whole-epoch
compression shares a dictionary across packets; it requires the complete archive
and changes the streaming latency contract. A smaller compressed archive alone
is not proof of a smaller prompt or faster checker.

`decode_wire` enforces envelope, output, packet, schema, coverage and count bounds.
A valid packet can still be an attacker-authored lie. Use an authenticated expected
commitment or the trusted verifier channel and protect reference state externally.
The research TCP receiver is an instrumented loopback collector, not a deployment
server. No external service is started by installing this package.

## Compile outside verification's critical path

```python
from hact.tree import CostModel, compact_balanced
from ichact.layout import Layout, select_validation
from ichact.blocked import fit_blocked

# Supply actual approved registry IDs and separate training/validation episodes.
# order is a permutation of canonical integer indices, learned from training only.
blocked = fit_blocked(registry, training, order, block_size=32)
fixed = Layout(tuple(registry), tuple(order),
               compact_balanced(len(registry), 8), CostModel())
candidates = {"incumbent": incumbent, "fixed8": fixed, "blocked32": blocked}
chosen, scores = select_validation(candidates, validation)
selected_layout = candidates[chosen]
```

The held-out evaluation set must not choose the order, block size or layout. The
fixed-backbone block compiler is exact only inside each constrained block. It may
lose to a simple balanced layout; preserve that baseline. Its DP workspace bound
excludes order learning and input traces, which are separately material costs.
Do not silently switch a contract to a layout with different semantic IDs.

## Priced-window API

```python
from ichact.window import PricedWindow

# Nonnegative, finite byte-cost matrix; diagonal zero. All layouts are precompiled.
policy = PricedWindow(migration_bytes, initial=0, window=64)
index = policy.choose()        # Before the current completion event is observed.
# Apply any actual migration through the protected generation-fenced kernel.
# After the event, compute comparable costs of that event for all catalogue layouts.
ledger_entry = policy.observe(full_information_event_costs)
checkpoint = policy.state()   # Valid only at an event boundary.
restored = PricedWindow.resume(checkpoint)
```

The library chooses indices and records costs; it does not mutate project state,
compile layouts, deploy code or authorize migration. The trusted caller must apply
migration and correctly account for canonical manifest bytes and cold rebuilding.
The last up to 64 exogenous event costs form a forecast. A proposal replaces the
incumbent only if 64 times its mean estimated saving exceeds the transition price.
During warmup, the available shorter history is used with the same 64-event forecast
horizon, matching the archived comparator. Equality retains the incumbent.

All catalogue costs for an event are required: this is a full-information rule,
not a bandit or a claim to observe unexecuted checker outcomes. The completion wave
is known after checking; per-layout aggregation cost can then be computed from it.
If layout affects check scheduling or outcomes, this exogeneity assumption fails.
No distribution-free regret guarantee is claimed for the rule. Avoid retuning it
on the reported evaluation streams. Keep `CoupledShare` only as a research comparator.

## Migration and authorization

Semantic identity, candidate snapshot and input bindings remain fixed across
reordering. Display positions are not check IDs. Publication tickets are checked
against protected generation state; reusing an old ticket after a source or layout
change is rejected. A report exported here cannot create a new publication ticket.
Correctness assumes complete dependencies and sound checkers. External I/O, hidden
configuration, stochastic tests and compromised local state need additional controls.

## Cost decision

Measure the actual codec and bottleneck. In a nonoverlapping, single-link accounting
model, extra layout fitting K amortized over N exports is justified only if saved
bytes divided by goodput exceed extra encode/decode work plus K/N. This is not a
WAN or queueing theorem. Do not cancel the strict wrapper's overhead when comparing
against direct pytest: those methods implement different contracts. Current evidence
supports byte savings and controlled export savings, not faster autonomous coding.
