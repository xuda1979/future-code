# Claude Code Onboarding — Future Code Team

Welcome! This guide gets you productive with **Claude Code** on this repository.
Two ways to use it:

1. **Read it** — the sections below are a complete tour.
2. **Paste it into Claude Code** — copy everything from the "Interactive walkthrough" link
   at the bottom into a Claude Code session in this repo, and it will walk you through
   everything hands-on.

---

## What this repo is

This repository is a **research mirror of the Future Code source snapshot**
(TypeScript, Bun runtime, React + Ink terminal UI, ~1,900 files, 500k+ lines),
plus the team's own work: the Foundry kernel, Foundry Swarm, HACT coordination,
context-retirement protocols, and the research paper. The compiled `future-code`
binary is built from this source — never downloaded.

## Repo map (what lives where)

| Path | What it is |
|---|---|
| `src/` | The Future Code source snapshot (~1,900 files) |
| `src/harness/foundry/` | Foundry kernel + swarm (scheduler, runtime, supervisor) |
| `tests/` | All test suites (foundry, swarm, hact, api, harness, retirement, research-jobs) |
| `scripts/test-*.mjs` | Test launchers — **the way tests are run** |
| `docs/agent-platform/` | Design docs: FOUNDRY, SWARM, PRODUCTIVITY, RESILIENT_RND |
| `docs/protocols/` | Context-retirement protocol versions |
| `paper/` | The research paper (LaTeX) |
| `build.sh` | Builds the `future-code` binary |
| `CLAUDE.md` | *(doesn't exist yet — see "First team task" below)* |

## How we build and test (the commands that matter)

```bash
./build.sh                        # compile the future-code binary (needs Bun ≥ 1.2)
./future-code --version           # verify the build

node scripts/test-resilience.mjs  # resilience acceptance gate + Python research-jobs
node scripts/test-foundry.mjs     # full foundry suite
node scripts/test-swarm.mjs       # swarm suite
node scripts/test-commands.mjs    # slash-command suite
node scripts/test-retirement.mjs  # retirement suite (runs under Bun internally)
bun test tests/hact tests/api tests/harness   # Bun-runtime suites
```

Two runtimes, deliberately: Node (`--experimental-strip-types`) for the foundry/swarm
suites, **Bun** for anything that imports `bun:bundle` or `bun:test` (hact, api, harness,
retirement). If a test fails with `Cannot find module '.../*.js'` under Node, it probably
belongs to the Bun group — don't "fix" the imports; run it with the right launcher.
(Static imports of `src/utils/messages.js` are a known trap — they only work in the Bun
binary because that module pulls in `bun:bundle`.)

## Claude Code essentials for this repo

### 1. Start sessions in the repo root
Claude Code reads the current directory tree automatically. From this repo:
```bash
cd /path/to/future-code
claude
```

### 2. CLAUDE.md — repo memory (we don't have one yet)
`CLAUDE.md` is the file Claude Code reads at session start for project conventions.
**This repo doesn't have one yet** — creating it is the natural first team task (see below).
Once it exists, it should capture: the build/test commands above, the two-runtime test
rule, and any code-style conventions.

### 3. Plan before you act: Plan Mode
Press **Shift+Tab** to cycle into Plan Mode. Claude reads the codebase, proposes an
approach, and waits for your approval before touching anything. Use it for anything
that spans more than one file — especially in `src/`, where a "small" change can ripple
across the 500k-line snapshot.

### 4. Permissions: how we let Claude run commands
On first use Claude Code will ask before running commands. Team convention:
- **Allow read-only commands freely**: `git status/log/diff`, `ls`, `grep`, `cat`, `node scripts/test-*.mjs`.
- **Be deliberate about writes**: `git add/commit/push`, `./build.sh`, anything under `src/`.
- Never blanket-approve `rm` or anything with `--force`.
Approvals can be session-scoped or saved; prefer session-scoped until you trust a pattern.

### 5. Let Claude run the tests
The single highest-leverage habit: after any change, ask Claude to run the relevant
launcher (`node scripts/test-foundry.mjs` etc.) and fix what's red before committing.
Claude reads TAP output well — just say "run the foundry suite and fix failures."

### 6. Work in Plan → Execute → Verify loops
The workflow that works on this repo:
1. Describe the goal; let Claude explore (`src/`, `docs/agent-platform/`) and plan.
2. Approve or amend the plan.
3. Claude edits; you review the diff (`git diff`).
4. Claude runs the matching test launcher + rebuilds if `src/` changed.
5. Commit with a message following the repo's convention:
   `feat(harness): ...`, `fix(tests): ...`, `feat(paper): ...` — scope in parens, imperative mood.

### 7. Git discipline
This repo pushes straight to `main` on `origin` (`github.com-future-code:xuda1979/future-code.git`).
- Keep commits single-purpose; the history reads like a changelog.
- Never commit secrets: `deepseek.env` and `*.zip` are gitignored for a reason.
- `__pycache__/` is gitignored; never commit `.pyc` files.

### 8. Asking Claude about the architecture
The design docs in `docs/agent-platform/` (FOUNDRY.md, SWARM.md, RESILIENT_RND.md) are the
source of truth for system behavior. Ask Claude things like:
- "Explain how the swarm supervisor handles crash recovery, citing RESILIENT_RND.md"
- "What does `runHealth` report and who consumes it?"
- "Which test launcher covers the file I just changed?"

### 9. Keep humans in the loop
Claude Code works best as a fast, tireless pair — not an unsupervised agent. Review diffs
before push, especially in `src/` and `paper/`. The team's own supervisor design
(see RESILIENT_RND.md) exists precisely because even the swarm requires an operator.

---

## First team task for a new teammate (good starter)

**Create the missing `CLAUDE.md`** for this repo. Concretely: ask Claude Code to
"read ONBOARDING.md and docs/agent-platform/, then draft a CLAUDE.md with the build/test
commands, the two-runtime test rule, and the commit-message convention." Review the draft,
adjust, and commit it. It's a perfect first contribution: useful, low-risk, and it teaches
you Plan Mode, file edits, and the commit flow end-to-end.

## Team tips for new teammates

*(to be filled in by the team — see below)*

- Run `node scripts/test-resilience.mjs` before pushing anything that touches `src/harness/foundry/`.
- If a Node test fails on `ERR_MODULE_NOT_FOUND ... .js`, check whether it's a Bun-suite test before debugging.
- `paper/` has generated files (`paper/generated/`) — regenerate, don't hand-edit.

---

## Interactive walkthrough

Paste everything below the line into a fresh Claude Code session in this repo for a
guided, hands-on tour:

---

I'm a new teammate onboarding with Claude Code on this repository. Walk me through a
hands-on tour, one step at a time, waiting for my confirmation between steps:

1. Show me the repo layout: list the top-level directories and explain what each is for
   (this is a research mirror of the Future Code source, plus Foundry/Swarm/HACT work,
   tests, and a paper). Point me at `docs/agent-platform/` and `docs/protocols/`.
2. Demonstrate read-only exploration: show me `git log --oneline -10`, then explain the
   commit-message convention (type(scope): description).
3. Introduce Plan Mode (Shift+Tab): explain what it's for and when to use it on this repo.
4. Explain the two-runtime test rule: Node launchers (`scripts/test-*.mjs`) vs
   `bun test tests/hact tests/api tests/harness`. Then run one launcher of my choice
   and interpret the output with me.
5. Show me how you'd build the binary with `./build.sh` and verify with
   `./future-code --version` — but ask me before actually running the build.
6. Walk me through the permissions prompt I'll see, and recommend what to allow
   (read-only = yes freely; writes to src/, git push, and builds = ask each time).
7. As a finale, help me draft the missing `CLAUDE.md`: propose its contents from what
   you've learned about this repo (build/test commands, two-runtime rule, commit
   convention), show me the draft, and let me decide whether to save it.

Keep each step short, confirm I'm following before moving on, and don't modify any
files until step 7, and only with my explicit go-ahead.
