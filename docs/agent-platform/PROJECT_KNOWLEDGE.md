# Autonomous project knowledge

Future-Code can accumulate project experience while working toward an objective.
An expert supplies the objective, optional seed packs/skills, and the project's
execution/verification capabilities. Routine discovery, recording, retrieval and
consolidation need no interview, approval queue or separate conversation. Experts
can still add advice during a run. Core code has no scientific domain registry.

## What this adds to skills and existing memory

| Asset | How it enters | Runtime meaning |
| --- | --- | --- |
| Expert/reference pack | Initial spec or optional import at any time | Attributed, content-versioned seed; not independently verified |
| Human Markdown or `SKILL.md` | `teach` command, initially or during work | Requests, procedures, experience and knowledge use the same attributed seed lifecycle |
| Structured experience | Agent calls `record_experience` during normal work | Trigger, lesson, conditions, workflow phase, tags and owned evidence references |
| Failure ledger | Host automatically indexes diagnostic checkpoints | Exact failed inputs; a crash/error alone does not falsify a hypothesis |
| Failure-to-pass transition | Host consolidates at independent source acceptance | Historical failure and accepted patch passed the same named check; cause remains unknown |
| Scientific finding | Host references an accepted research-programme finding | Exact protocol, assumptions, assessment and evidence; positive, negative and inconclusive outcomes are retained |
| Validated lesson | Existing independent claim adjudication | Only the exact lesson **and conditions** are supported; revisions/retractions revoke that trust |
| Portable method pack | Explicit export/import | Reusable references/procedures become unverified seeds in the destination |

The existing `agent_memory` stays task-local and retains cold episodes.
`ResearchProgramme` remains authoritative for scientific finding versions,
dependency invalidation, conflicts and retractions. Claims keep their existing
machine-checkable adjudication boundary. The new project index connects these
objects to reusable context; it is neither another scheduler nor a truth solver.

## Enable once

Add this optional policy to a Swarm spec:

```json
{
  "projectKnowledge": {
    "namespace": "project-rnd",
    "maxCardsPerTask": 8,
    "maxContextBytes": 4096
  }
}
```

Both shipped Swarm example specs enable this policy and the knowledge tools.
Custom specs retain their explicit opt-in. Initialize a new state store with the
updated spec; existing frozen configurations are not silently rewritten.

Include `record_experience`, `read_knowledge` and `recall` in the profiles that
should learn/retrieve project knowledge. They supplement existing scoped file
reads/searches, checks and authorized research jobs. Agents without these tools
retain their capability boundary. Other profiles can still contribute automatic
host-observed failures. Without the policy, no project-knowledge tables, context
retrieval or extra model requests are added.

The project identity combines the canonical repository path and namespace.
Knowledge persists across runs using the same store. A different repository or
namespace does not silently inherit it. `projectKnowledge` is explicit authority
to share the recorded cards within that project. Agent-authored experience is
shared only when its exact source patch passes independent acceptance. Earlier
patches and rejected tasks do not publish their prose lessons. Host-observed
failures remain useful even if the source task fails.

Seed packs can be embedded in `projectKnowledge.packs` (up to eight packs) or
imported later. See [`examples/swarm/project-knowledge-pack.json`](../../examples/swarm/project-knowledge-pack.json).
Each pack includes source attribution and bounded entries, with explicit
conditions. Content hashes identify versions; reimporting identical bytes is
idempotent. Changed versions coexist with history. An operator may retire an
obsolete version without deleting it. A pack is suitable for Git review, but
review is optional for runtime learning.

## Teach the project in Markdown

Scientists and developers can keep their methods in a normal `SKILL.md`, or write
requests, observations and background knowledge as Markdown or plain text. Import
one file into an initialized Swarm project with:

```sh
node --experimental-strip-types src/harness/foundry/swarm/cli.ts teach \
  --root STATE --file path/to/SKILL.md --id measurement-review --kind skill \
  --source 'Project maintainer' \
  --trigger 'measurement schema baseline validation' \
  --conditions 'Use with this project and its pinned validators; recheck assumptions on new data.' \
  --tags measurement,schema --phase validation --allow-exec
```

The interactive application accepts the same arguments after `/swarm teach`.
`--source`, `--tags` and `--phase` are optional; source defaults to the filename
and phase to `any`. Choose concrete trigger words/tags that also appear in task
goals, file scopes or check names: automatic retrieval uses literal terms.

| `--kind` | Human input | Seed meaning |
| --- | --- | --- |
| `request` | Persistent priorities, preferences or project requests | Constraint guidance within the frozen task contract |
| `skill` | Reusable procedure or a `SKILL.md` | Procedure to consult under its declared conditions |
| `experience` | Lessons, failed approaches or practical observations | Reference advice with explicit applicability |
| `knowledge` | Background, definitions or domain notes | Reference material with attribution |

Use task/goal files for work to execute, and pinned checks for mandatory acceptance
requirements. A saved request is retrieved guidance; it does not enqueue tasks or
edit a running objective. All four kinds retain `EXPERT_SEED_UNVERIFIED` trust.
Human attribution establishes provenance; scientific assertions still need
independent evidence. Skill frontmatter cannot grant tools or change budgets,
scope or checks through this import.

The importer reads at most 64 KiB of valid UTF-8 from one regular local file.
It preserves the complete text, including frontmatter, in ordered parts of at
most 2048 bytes each. Each part identifies its position and a version-specific
retrieval tag. Workers should retrieve every part, follow pagination, and read
them in order before applying a multipart procedure. The automatic digest alone
may show only a subset. Referenced files/URLs, hooks and shell substitutions are
stored as text; import does not fetch or execute them. Import supporting files
separately or expose them through ordinary scoped reads/adapters.

Text and metadata determine the version. Reimporting the same file and metadata
is idempotent. Editing the file requires another import; the old version stays
inspectable. The result lists card IDs, so `experience-retire` can retire each
obsolete part explicitly. An import during work becomes eligible for retrieval
at the next complete model-request boundary, subject to phase/query/context
bounds. Saved replies still replay against their original context.

The interactive session's native skill loader also discovers
`.future/skills/<name>/SKILL.md` in the project and skills in the user config
directory. Swarm uses the explicit `teach` bridge above, so an operator can reuse
the same document while keeping the long-running runtime's capability contract.

## Autonomous discovery and consolidation

The worker is instructed to inspect needed references and preserve reusable
lessons as part of its normal R&D work, using its admitted tools. It can read a
project manual, inspect a dataset schema/notebook, or consume a configured
research/search adapter, then record an atomic experience with the originating
receipt IDs. No new unrestricted web client, PDF/vision parser or arbitrary
command executor is introduced. Projects can supply those extraction/search
capabilities through existing adapters and retain the extracted provenance.

```json
{
  "id": "input-contract-lesson-v1",
  "kind": "procedure",
  "trigger": "schema mismatch in measurement input",
  "lesson": "Validate the declared measurement schema before the expensive job.",
  "conditions": "Only for this project's schema and the pinned validator version.",
  "phase": "design",
  "tags": ["measurement", "schema"],
  "receipts": ["OWNED_RECEIPT_HASH"]
}
```

New evidence uses a new experience ID. Reusing an ID requires identical input
and source patch. Receipt references must belong to the recording thread. The
recording step is bounded by the ordinary tool/turn budget. It does not call a
second model. At acceptance, publication commits in the same transaction as
task PASS; a crash rolls both back.

Failure descriptors enter the project ledger in the same transaction as their
source journal event. Repeated identical fixtures are deduplicated. Raw error
logs, full transcripts and unbounded job parameters are not copied into the
shared failure preview. Failure records retain original input and fixture
references. Retrieval grants access to the card, **not** its source task's
private receipt bodies.

For a failure-to-pass transition, the host matches the failed `run_check` name
to the final independent check report on a different accepted patch. It records
the before/after references and `rootCause: null`. It does not infer a causal
fix, successful ablation, reproducibility or a general rule. Different checks,
unchanged patches and unsupported backend report formats produce no transition.
The accepted task still needs every frozen check.

With both `projectKnowledge` and `researchProgramme` configured, accepted
scientific findings enter retrieval automatically. The card references the
existing exact finding version instead of copying scientific logic into the
core. A later programme retraction, supersession or conflict changes the card's
runtime trust label immediately; historical observations remain inspectable.
A valid negative experiment can be scientifically useful without becoming a
universal prohibition on that research direction.

## Promotion and correction

A source task's passing tests do not verify arbitrary prose. Experience defaults
to `UNVERIFIED_LOCAL_HYPOTHESIS` or `UNVERIFIED_LESSON_ACCEPTED_SOURCE`.
To validate a contextual lesson, its optional `claimId` must name this task's
claim whose statement is exactly:

```text
canonical({ lesson: EXPERIENCE_LESSON, conditions: EXPERIENCE_CONDITIONS })
```

The existing host adjudication path must then accept an independent,
machine-checkable discriminator for that exact claim. Retrieval rechecks the
claim statement, dependency versions, adjudication and source acceptance before
returning `VALIDATED_CLAIM_WITH_CONDITIONS`. A unit test, model confidence score,
ordinary task PASS or majority vote cannot substitute for that adjudication.
Scientific/statistical validation still belongs to the configured project
validator: this mechanism does not infer causality or statistical significance.

An agent may list up to four visible card IDs in `contradicts`. Both views stay
visible and are marked contested after the correcting experience is published.
This is a reported disagreement, not an automatically resolved logical conflict.
It cannot modify seed files or frozen acceptance constraints. Verified claim and
research conflicts retain their existing adjudication/invalidation mechanisms.
Use pinned executable checks for hard domain constraints; imported prose cannot
rewrite or bypass them.

Generated procedures are reusable knowledge assets, not automatically executable
global skills. Skill/script modifications continue through ordinary scoped edits
and verification. Automatically patching expert instructions or promoting one
lucky run into a universal skill would corrupt future work.

## Bounded retrieval and persistence

Before a normal model request, the host refreshes one project digest. Query terms
interleave the task goal, write scopes, read scopes and configured check names,
deduplicated to at most 32 literal terms. A long goal cannot consume the space
reserved for file and check identifiers. Debugging
selects `debugging`/`any` cards; otherwise the default phase admits all phases.
Agents can explicitly select `research`, `design`, `implementation`, `debugging`,
`validation` or `any` and supply a narrower query using `read_knowledge`.

Explicit `read_knowledge` search matches literal tags/trigger terms, newest first.
It uses an SQLite term
index, project/phase/source indexes, keyset cursors and a `limit + 1` candidate
page, rather than scanning whole transcripts. This is a deterministic baseline,
not semantic/vector search or a proof of absence. Synonyms and differently
segmented language may require explicit tags or another query. Follow
`nextAfter` when `hasMore` is true; the cursor moves toward older records.

The automatic digest ranks eligible indexed matches by the number of distinct
query terms they cover, with recency breaking ties. It considers the best 32
candidate references, then greedily selects up to three cards: prefer coverage
of query terms not yet represented, then total matches, then recency. This can
retrieve an older specific finding ahead of newer generic matches and add a
complementary reference before another card covering the same terms. It does
not infer semantic relevance, truth, utility or scientific confidence.

Project, publication, retirement and phase filters apply before the candidate
limit. Only selected cards are opened and authenticated; their exact indexed
term matches are checked against immutable source content. Current trust,
retraction and contradiction labels are rechecked on every refresh. `selection`
reports the candidate count and whether the pool was capped; it is not a paged
search result. Use explicit `read_knowledge` queries and their `nextAfter`
cursors to explore further. The cap bounds candidate metadata and artifact
reads, **not** the number of matching index postings SQLite must aggregate.
Very common terms can cost more to rank as a project grows. Complementary cards
outside the top 32 and synonyms can still be missed; this is not proof of absence.

The digest fits the smaller of the policy budget and one quarter of the admitted
thread context. Very small envelopes skip automatic injection. Large previews
are omitted while card IDs, trust labels and applicability remain. Use `read_knowledge({id: CARD_ID})` to
obtain a full owned card receipt and `recall` for byte slices. The full encoded
provider request remains subject to the existing context limit.

The digest replaces its previous projection and is checkpointed before model
intent. Recovery consumes a saved model reply against its original context
before learning updates can change the next request. Knowledge cannot fabricate
PASS, grant execution capabilities, remove a failed check or widen task scope.

Card/pack contents and publication/retirement histories are immutable artifacts
and append-only records. The `project_knowledge_uses` table records distinct
task/card retrieval pairs. This is exposure telemetry, not a causal productivity
score. No automatic deletion/pruning is based on unmeasured downstream utility;
rare but important failure knowledge must not disappear merely because it is
infrequently retrieved. Each task admits at most `maxCardsPerTask` records per
automatic/candidate class; the bound is at most 32. Store growth across runs is
intentional; back up the database and artifacts consistently.

## Optional inspection and transfer

These are host operations, not steps a human must perform between R&D iterations:

```sh
node --experimental-strip-types src/harness/foundry/swarm/cli.ts experience --root STATE --query measurement --phase design
node --experimental-strip-types src/harness/foundry/swarm/cli.ts experience --root STATE --hash CARD_ID
node --experimental-strip-types src/harness/foundry/swarm/cli.ts experience-import --root STATE --spec PACK.json --allow-exec
node --experimental-strip-types src/harness/foundry/swarm/cli.ts experience-retire --root STATE --hash CARD_ID --reason 'obsolete assumptions' --allow-exec
node --experimental-strip-types src/harness/foundry/swarm/cli.ts experience-export --root STATE --finding reusable-method --hash CARD_ID
```

The export command returns a portable JSON pack; the host API can export up to
32 selected cards at once. Destination imports are always unverified seeds,
including when the source lesson was validated. Evidence and conditions must be
re-established in the destination. There is no automatic cross-project data
pool or universally trusted meta-skill store.

## Validation and limits

`tests/foundry/project-knowledge.test.ts` covers versioned import/transfer,
replay, ownership, budgets, transaction rollback, exact semantic promotion,
withdrawal, contradictions, source integrity and bounded UTF-8 retrieval.
The Git/check end-to-end fixture demonstrates failure capture and reuse in a
later run without additional summarizer requests. Scientific framework tests
exercise accepted positive/negative observations and retraction using an
arbitrary domain name.

`tests/foundry/human-knowledge.test.ts` covers human input kinds, complete
multilingual multipart text, file bounds, inert skill directives, persistent and
idempotent CLI imports, real worker-context reuse and unchanged independent
acceptance. These tests run in both Foundry and Swarm regression suites.

`tests/foundry/project-knowledge-selection.test.ts` covers older specific advice
behind forty newer broad matches, long goals, complementary term coverage,
privacy/phase/retirement filtering before ranking, candidate and UTF-8 bounds,
source authentication, stable chronological pagination and deterministic reopen.
The two worker-context regressions fail on the preceding runtime and pass with
ranked retrieval using the same two scripted model responses and independent
checks. They establish retrieval behavior, not live-model productivity gains.

These tests establish runtime behavior. They are scripted/offline evidence,
not measurements of live-model productivity or a claim of expert performance
in every domain. Ontology/vector backends, automatic causal-ablation design,
multimodal extractors and empirical skill-utility evaluation remain extensions
through the existing capability and verification boundaries.
