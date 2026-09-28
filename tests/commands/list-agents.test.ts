/**
 * Tests for the /list-agents command and the other Claude-parity commands
 * added alongside it: /todos, /recap, /pause-memory, /autocompact,
 * /skill-doctor, /focus, /usage-credits (alias).
 *
 * Per the two-runtime rule, this suite runs under Node: lazy load() targets
 * (list-agents.ts etc.) import runtime .js specifiers only Bun resolves, so
 * behavior is tested via the dependency-free leaf modules and registry
 * wiring via source assertions.
 *
 * Run with: node scripts/test-commands.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import listAgents from "../../src/commands/list-agents/index.ts";
import todos from "../../src/commands/todos/index.ts";
import recap from "../../src/commands/recap/index.ts";
import pauseMemory from "../../src/commands/pause-memory/index.ts";
import autocompact from "../../src/commands/autocompact/index.ts";
import skillDoctor from "../../src/commands/skill-doctor/index.ts";
import focus from "../../src/commands/focus/index.ts";

import {
  AGENT_DISPLAY_GROUPS,
  formatAgentsJson,
  formatAgentsText,
} from "../../src/commands/list-agents/format.ts";
import { formatTodos } from "../../src/commands/todos/format.ts";
import { applyPauseMemory } from "../../src/commands/pause-memory/pause-memory-logic.ts";
import { parseAutocompactArgs } from "../../src/commands/autocompact/autocompact-logic.ts";
import { formatSkillDoctor } from "../../src/commands/skill-doctor/skill-doctor-format.ts";
import { filterForFocusView } from "../../src/utils/focusView.ts";

// ─── /list-agents ───────────────────────────────────────────────────────────

test("list-agents command metadata", () => {
  assert.equal(listAgents.type, "local");
  assert.equal(listAgents.name, "list-agents");
  assert.ok(listAgents.description.length > 0);
  // Non-interactive-safe: pure text output, no JSX.
  assert.equal(listAgents.supportsNonInteractive, true);
  assert.equal(typeof listAgents.load, "function");
});

test("AGENT_DISPLAY_GROUPS matches agentDisplay.ts source groups", () => {
  const source = readFileSync(
    join(process.cwd(), "src/tools/AgentTool/agentDisplay.ts"),
    "utf-8",
  );
  for (const { label, source: src } of AGENT_DISPLAY_GROUPS) {
    if (src === "built-in") continue // label differs by design ("Built-in agents")
    assert.ok(
      source.includes(`{ label: '${label}', source: '${src}' }`),
      `group ${label}/${src} must mirror agentDisplay.ts`,
    );
  }
});

test("list-agents formatAgentsText renders groups and shadowed agents", () => {
  const out = formatAgentsText(
    [
      { name: "future-code-guide", source: "built-in", model: "haiku", description: "docs" },
      { name: "general-purpose", source: "built-in", description: "anything" },
      { name: "my-agent", source: "projectSettings", description: "custom" },
      {
        name: "dupe",
        source: "userSettings",
        overriddenByLabel: "project",
        description: "shadowed",
      },
    ],
    [],
  );
  assert.ok(out.includes("3 active agents"), "counts non-shadowed agents");
  assert.ok(out.includes("Built-in agents:"));
  assert.ok(out.includes("future-code-guide · haiku"));
  assert.ok(out.includes("(shadowed by project)"), "labels shadowed agents");
  assert.ok(!out.includes("Failed to load"), "no failure section when empty");
});

test("list-agents formatAgentsText reports failed files", () => {
  const out = formatAgentsText([], [
    { path: "/tmp/bad-agent.md", error: "frontmatter parse error" },
  ]);
  assert.ok(out.includes("Failed to load some agent files:"));
  assert.ok(out.includes("/tmp/bad-agent.md"));
  assert.ok(out.includes("frontmatter parse error"));
});

test("list-agents formatAgentsText empty state", () => {
  assert.equal(formatAgentsText([], []), "No agents found.");
});

test("list-agents formatAgentsJson shape", () => {
  const json = JSON.parse(
    formatAgentsJson([
      { name: "general-purpose", source: "built-in", description: "x" },
      {
        name: "dupe",
        source: "userSettings",
        overriddenByLabel: "built-in",
        description: "y",
      },
    ]),
  ) as Array<{ name: string; active: boolean; overriddenBy?: string }>;
  assert.equal(json.length, 2);
  assert.deepEqual(
    json.map(a => a.name),
    ["general-purpose", "dupe"],
  );
  assert.equal(json[0].active, true);
  assert.equal(json[0].model, "inherit", "missing model defaults to inherit");
  assert.equal(json[1].active, false);
  assert.ok("overriddenBy" in json[1]);
  assert.ok(!("overriddenBy" in json[0]));
});

// ─── /todos ─────────────────────────────────────────────────────────────────

test("todos command metadata", () => {
  assert.equal(todos.type, "local");
  assert.equal(todos.name, "todos");
  assert.equal(todos.supportsNonInteractive, true);
});

test("todos formatTodos renders checklist with status glyphs and progress", () => {
  const out = formatTodos([
    { content: "Write tests", status: "completed", activeForm: "Writing tests" },
    { content: "Ship feature", status: "in_progress", activeForm: "Shipping feature" },
    { content: "File PR", status: "pending", activeForm: "Filing PR" },
  ]);
  assert.ok(out.includes("1/3 completed"));
  assert.ok(out.includes("[x] Write tests"));
  assert.ok(out.includes("[~] Shipping feature…"), "in_progress uses activeForm");
  assert.ok(out.includes("[ ] File PR"));
});

test("todos formatTodos empty state", () => {
  const out = formatTodos([]);
  assert.ok(out.includes("No todos yet"));
});

// ─── /recap ─────────────────────────────────────────────────────────────────

test("recap command is a prompt command with content", async () => {
  assert.equal(recap.type, "prompt");
  assert.equal(recap.name, "recap");
  assert.ok(recap.description.length > 0);
  const blocks = await recap.getPromptForCommand("", {} as never);
  assert.ok(Array.isArray(blocks), "must return ContentBlockParam[]");
  const text = blocks.map(b => ("text" in b ? b.text : "")).join("\n");
  assert.ok(text.length > 0);
  assert.ok(/single-sentence/i.test(text));
});

// ─── /pause-memory ──────────────────────────────────────────────────────────

test("pause-memory command metadata", () => {
  assert.equal(pauseMemory.type, "local");
  assert.equal(pauseMemory.name, "pause-memory");
  assert.equal(pauseMemory.supportsNonInteractive, true);
});

test("pause-memory logic: pause, resume, settings-disabled, bad arg", () => {
  // Default pause
  let r = applyPauseMemory("", false, false);
  assert.ok(/paused/i.test(r.value));
  assert.equal(r.disableAutoMemory, true);

  // Explicit pause
  r = applyPauseMemory("pause", false, false);
  assert.equal(r.disableAutoMemory, true);

  // Resume clears
  r = applyPauseMemory("resume", false, true);
  assert.equal(r.disableAutoMemory, false);
  assert.ok(/resumed/i.test(r.value));

  // Resume with settings-disabled warns
  r = applyPauseMemory("unpause", true, true);
  assert.ok(/still disabled by your settings/i.test(r.value));

  // Pause when settings also disabled adds a note
  r = applyPauseMemory("", true, false);
  assert.ok(/also disabled in your settings/i.test(r.value));

  // Bad argument
  r = applyPauseMemory("bogus", false, false);
  assert.ok(/unknown argument/i.test(r.value));
  assert.equal(r.disableAutoMemory, false, "bad arg leaves state untouched");
});

// ─── /autocompact ───────────────────────────────────────────────────────────

test("autocompact command metadata", () => {
  assert.equal(autocompact.type, "local");
  assert.equal(autocompact.name, "autocompact");
  assert.equal(autocompact.supportsNonInteractive, true);
  assert.ok(autocompact.argumentHint);
});

test("autocompact arg parsing: status/on/off/percent/garbage", () => {
  assert.deepEqual(parseAutocompactArgs(""), { kind: "status" });
  assert.deepEqual(parseAutocompactArgs("status"), { kind: "status" });
  assert.deepEqual(parseAutocompactArgs("on"), { kind: "set-enabled", enabled: true });
  assert.deepEqual(parseAutocompactArgs("off"), { kind: "set-enabled", enabled: false });
  assert.deepEqual(parseAutocompactArgs("80"), { kind: "set-percent", percent: 80 });
  assert.deepEqual(parseAutocompactArgs(" 12.5 "), { kind: "set-percent", percent: 12.5 });
  assert.equal(parseAutocompactArgs("0").kind, "error");
  assert.equal(parseAutocompactArgs("101").kind, "error");
  assert.equal(parseAutocompactArgs("bananas").kind, "error");
  assert.ok(/invalid argument/i.test(
    (parseAutocompactArgs("bananas") as { message: string }).message,
  ));
});

// ─── /skill-doctor ──────────────────────────────────────────────────────────

test("skill-doctor command metadata", () => {
  assert.equal(skillDoctor.type, "local");
  assert.equal(skillDoctor.name, "skill-doctor");
  assert.equal(skillDoctor.supportsNonInteractive, true);
});

test("skill-doctor formatSkillDoctor lists cost-sorted rows", () => {
  const out = formatSkillDoctor(
    [
      { name: "commit", tokens: 50, usedThisSession: false, source: "skills" },
      { name: "pdf", tokens: 900, usedThisSession: true, source: "plugin" },
    ],
    "12345678-1234-1234-1234-123456789012",
  );
  assert.ok(out.includes("2 skills loaded"));
  assert.ok(out.includes("~950 tokens"));
  assert.ok(out.includes("1 unused this session"));
  // Sorted: pdf (900) before commit (50)
  assert.ok(out.indexOf("pdf") < out.indexOf("commit"));
  assert.ok(out.includes("(session 12345678"));
});

test("skill-doctor formatSkillDoctor empty state", () => {
  const out = formatSkillDoctor([], "00000000-0000-0000-0000-000000000000");
  assert.ok(out.includes("No skills loaded"));
});

// ─── /focus ─────────────────────────────────────────────────────────────────

test("focus command metadata", () => {
  assert.equal(focus.type, "local-jsx");
  assert.equal(focus.name, "focus");
  assert.equal(focus.immediate, true);
  assert.equal(typeof focus.load, "function");
});

test("focus filters down to the latest exchange", () => {
  const msgs = [
    { type: "user", message: { content: [{ type: "text" }] } },
    { type: "assistant", message: { content: [{ type: "text" }] } },
    { type: "user", message: { content: [{ type: "text" }] } },
    { type: "assistant", message: { content: [{ type: "text" }] } },
  ];
  const out = filterForFocusView(msgs);
  assert.equal(out.length, 2, "keeps only the latest exchange");
  assert.equal(out[0].type, "user");
  assert.equal(out[1].type, "assistant");
});

test("focus view keeps compact summaries and doesn't treat tool-results as prompts", () => {
  // The tool_result at index 2 comes AFTER the real prompt at index 1. It is
  // part of the in-flight exchange, not a prompt boundary — so it must stay.
  // The point of the tool_result check is: a trailing tool_result must not
  // push the boundary to itself (which would hide the prompt it answers).
  const msgs = [
    { type: "system", subtype: "compact", message: { content: [] } },
    { type: "user", isMeta: false, message: { content: [{ type: "text" }] } },
    {
      type: "user",
      isMeta: false,
      message: { content: [{ type: "tool_result" }] },
    },
    { type: "assistant", message: { content: [{ type: "text" }] } },
  ];
  const out = filterForFocusView(msgs);
  assert.ok(out.some(m => m.type === "system"), "compact summary survives");
  assert.equal(out.length, 4, "latest exchange keeps its tool_result turn");
  assert.ok(
    out.some(m => m.type === "user" && m.message?.content[0]?.type === "text"),
    "the real prompt is kept",
  );
});

test("focus view: trailing tool_result does not hide the prompt it answers", () => {
  // If a tool_result were (wrongly) treated as a prompt, the boundary would
  // land on it and the user prompt before it would vanish. It must not.
  const msgs = [
    { type: "user", isMeta: false, message: { content: [{ type: "text" }] } },
    {
      type: "user",
      isMeta: false,
      message: { content: [{ type: "tool_result" }] },
    },
  ];
  const out = filterForFocusView(msgs);
  assert.equal(out.length, 2, "both turns kept");
  assert.equal(out[0].message?.content[0]?.type, "text", "prompt is first");
});

test("focus view with no prompts keeps everything", () => {
  const msgs = [
    { type: "system", subtype: "api_metrics", message: { content: [] } },
    { type: "assistant", message: { content: [{ type: "text" }] } },
  ];
  const out = filterForFocusView(msgs);
  assert.equal(out.length, 2, "no prompt boundary → unfiltered");
});

// ─── /usage-credits alias ───────────────────────────────────────────────────
// extra-usage/index.ts imports runtime modules (bun-only .js specifiers), so
// assert on source — the alias is what Claude Code calls usage-credits.

test("usage-credits is an alias of extra-usage", () => {
  const source = readFileSync(
    join(process.cwd(), "src/commands/extra-usage/index.ts"),
    "utf-8",
  );
  const aliasCount = (
    source.match(/aliases: \['usage-credits'\]/g) ?? []
  ).length;
  assert.ok(
    aliasCount >= 2,
    "both extra-usage command variants must carry the usage-credits alias",
  );
});

// ─── Registration in commands.ts ────────────────────────────────────────────

test("all parity commands are registered in commands.ts", () => {
  const source = readFileSync(join(process.cwd(), "src/commands.ts"), "utf-8");
  for (const [name, importName] of [
    ["list-agents", "listAgents"],
    ["todos", "todos"],
    ["recap", "recap"],
    ["pause-memory", "pauseMemory"],
    ["autocompact", "autocompact"],
    ["skill-doctor", "skillDoctor"],
    ["focus", "focus"],
  ] as const) {
    assert.ok(
      source.includes(`import ${importName} from './commands/${name}/index.js'`),
      `${importName} import must exist`,
    );
    assert.ok(
      new RegExp(`^  ${importName},$`, "m").test(source),
      `${importName} must be in COMMANDS array`,
    );
  }
});

test("focusMode wired through REPL and AppState", () => {
  const repl = readFileSync(join(process.cwd(), "src/screens/REPL.tsx"), "utf-8");
  assert.ok(repl.includes("s.focusMode"), "REPL reads focusMode from AppState");
  assert.ok(
    repl.includes("focusMode={viewedAgentTask ? false : focusMode}"),
    "REPL passes focusMode to Messages",
  );
  const state = readFileSync(
    join(process.cwd(), "src/state/AppStateStore.ts"),
    "utf-8",
  );
  assert.ok(state.includes("focusMode: boolean"), "AppState has focusMode");
  assert.ok(state.includes("focusMode: false,"), "focusMode defaults off");

  const messages = readFileSync(
    join(process.cwd(), "src/components/Messages.tsx"),
    "utf-8",
  );
  assert.ok(
    messages.includes("focusMode && !isTranscriptMode ? filterForFocusView"),
    "Messages applies the focus filter outside transcript mode",
  );
  assert.ok(
    messages.includes("from '../utils/focusView.js'"),
    "Messages imports the shared focus filter",
  );
});
