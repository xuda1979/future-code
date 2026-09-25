/**
 * Tests for the new slash commands: /goal, /loop, /retry, /save, /load, /watch, /learn.
 * Run with: node --experimental-strip-types --test tests/commands/commands.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Import the command definitions
import goal from "../../src/commands/goal/index.ts";
import loop from "../../src/commands/loop/index.ts";
import retry from "../../src/commands/retry/index.ts";
import save from "../../src/commands/save/index.ts";
import load from "../../src/commands/load/index.ts";
import watch from "../../src/commands/watch/index.ts";
import learn from "../../src/commands/learn/index.ts";

// ─── /goal command ──────────────────────────────────────────────────────────

test("goal command has correct metadata", () => {
  assert.equal(goal.name, "goal");
  assert.equal(goal.type, "prompt");
  assert.ok(goal.description.length > 0, "description must not be empty");
  assert.ok(goal.argumentHint, "argumentHint must be defined");
  assert.ok(goal.progressMessage, "progressMessage must be defined");
  assert.ok(goal.contentLength > 0, "contentLength must be positive");
  assert.equal(goal.source, "builtin");
});

test("goal command getPromptForCommand returns set-goal prompt when args provided", () => {
  const prompt = goal.getPromptForCommand("Build a REST API for user management");
  assert.ok(prompt.includes("Build a REST API for user management"));
  assert.ok(prompt.includes("GOAL:"));
  assert.ok(prompt.includes(".future-code/goal.md"));
  assert.ok(prompt.includes("checklist"));
  assert.ok(prompt.includes("in_progress"));
});

test("goal command getPromptForCommand returns view-goal prompt when no args", () => {
  const prompt = goal.getPromptForCommand("");
  assert.ok(prompt.includes(".future-code/goal.md"));
  assert.ok(prompt.includes("no goal has been set") || prompt.includes("summarize"));
});

test("goal command getPromptForCommand handles whitespace-only args", () => {
  const prompt = goal.getPromptForCommand("   ");
  assert.ok(!prompt.includes("GOAL:"));
});

test("goal command getPromptForCommand handles special characters in goal", () => {
  const prompt = goal.getPromptForCommand("Fix bug #123 in src/index.ts (urgent!)");
  assert.ok(prompt.includes("Fix bug #123 in src/index.ts (urgent!)"));
});

test("goal prompt includes anti-refusal safeguard for post-completion", () => {
  const prompt = goal.getPromptForCommand("some goal");
  assert.ok(prompt.includes("does NOT end the session"), "goal prompt must tell assistant not to end session on completion");
  assert.ok(prompt.includes("remain fully available"), "goal prompt must instruct assistant to remain available after completion");
  assert.ok(prompt.includes("completed"), "goal prompt must mention completion state");
});

// ─── /loop command ──────────────────────────────────────────────────────────

test("loop command has correct metadata", () => {
  assert.equal(loop.name, "loop");
  assert.equal(loop.type, "prompt");
  assert.ok(loop.description.length > 0);
  assert.ok(loop.argumentHint);
  assert.ok(loop.progressMessage);
  assert.ok(loop.contentLength > 0);
  assert.equal(loop.source, "builtin");
});

test("loop command parses prompt with stop condition", () => {
  const prompt = loop.getPromptForCommand("fix failing tests stop: all tests pass");
  assert.ok(prompt.includes("fix failing tests"));
  assert.ok(prompt.includes("STOP CONDITION: all tests pass"));
  assert.ok(prompt.includes("STOP CONDITION:"));
  assert.ok(prompt.includes("LOOP PROTOCOL"));
});

test("loop command parses prompt without stop condition", () => {
  const prompt = loop.getPromptForCommand("improve code quality");
  assert.ok(prompt.includes("improve code quality"));
  assert.ok(prompt.includes("No explicit stop condition"));
  assert.ok(prompt.includes("5 iterations"));
});

test("loop command handles empty args with help message", () => {
  const prompt = loop.getPromptForCommand("");
  assert.ok(prompt.includes("/loop"));
  assert.ok(prompt.includes("stop:"));
  assert.ok(prompt.includes("Example"));
});

test("loop command handles case-insensitive stop: keyword", () => {
  const prompt = loop.getPromptForCommand("refactor code STOP: linting passes");
  assert.ok(prompt.includes("STOP CONDITION: linting passes"));
  assert.ok(prompt.includes("refactor code"));
});

test("loop command preserves complex prompts with special chars", () => {
  const prompt = loop.getPromptForCommand("fix {json} parsing in src/parser.ts stop: all edge cases handled");
  assert.ok(prompt.includes("fix {json} parsing in src/parser.ts"));
  assert.ok(prompt.includes("all edge cases handled"));
});

test("loop prompt contains iteration protocol", () => {
  const prompt = loop.getPromptForCommand("do something stop: done");
  assert.ok(prompt.includes("iteration 1"));
  assert.ok(prompt.includes("iteration"));
});

test("loop prompt includes anti-refusal safeguard for post-completion", () => {
  const prompt = loop.getPromptForCommand("do work stop: done");
  assert.ok(prompt.includes("does NOT end the session"), "loop prompt must tell assistant not to end session on loop completion");
  assert.ok(prompt.includes("remain fully available"), "loop prompt must instruct assistant to remain available after loop completes");
});

// ─── /retry command ─────────────────────────────────────────────────────────

test("retry command has correct metadata", () => {
  assert.equal(retry.name, "retry");
  assert.equal(retry.type, "prompt");
  assert.ok(retry.description.length > 0);
  assert.ok(retry.argumentHint);
  assert.ok(retry.progressMessage);
  assert.equal(retry.source, "builtin");
});

test("retry command with no args requests different approach", () => {
  const prompt = retry.getPromptForCommand("");
  assert.ok(prompt.includes("different approach"));
  assert.ok(prompt.includes("INSTRUCTIONS"));
  assert.ok(prompt.includes("DIFFERENT strategy"));
});

test("retry command with modified instructions includes them", () => {
  const prompt = retry.getPromptForCommand("use a more aggressive optimization");
  assert.ok(prompt.includes("use a more aggressive optimization"));
  assert.ok(prompt.includes("Additional instructions"));
});

test("retry command emphasizes not repeating same approach", () => {
  const prompt = retry.getPromptForCommand("");
  assert.ok(prompt.includes("DIFFERENT strategy"));
  assert.ok(prompt.includes("Do not repeat"));
});

// ─── /save command ──────────────────────────────────────────────────────────

test("save command has correct metadata", () => {
  assert.equal(save.name, "save");
  assert.equal(save.type, "prompt");
  assert.ok(save.description.length > 0);
  assert.ok(save.argumentHint);
  assert.ok(save.progressMessage);
  assert.equal(save.source, "builtin");
});

test("save command with name includes it in output", () => {
  const prompt = save.getPromptForCommand("my-work-progress");
  assert.ok(prompt.includes("my-work-progress"));
  assert.ok(prompt.includes(".future-code/snapshots/my-work-progress.md"));
  assert.ok(prompt.includes("SNAPSHOT NAME"));
  assert.ok(prompt.includes("goal"));
  assert.ok(prompt.includes("accomplished"));
});

test("save command without name generates a default", () => {
  const prompt = save.getPromptForCommand("");
  assert.ok(prompt.includes("snapshot-"));
  assert.ok(prompt.includes(".future-code/snapshots/"));
});

test("save command mentions /load for resumption", () => {
  const prompt = save.getPromptForCommand("test-snapshot");
  assert.ok(prompt.includes("/load test-snapshot"));
});

// ─── /load command ──────────────────────────────────────────────────────────

test("load command has correct metadata", () => {
  assert.equal(load.name, "load");
  assert.equal(load.type, "prompt");
  assert.ok(load.description.length > 0);
  assert.ok(load.argumentHint);
  assert.ok(load.progressMessage);
  assert.equal(load.source, "builtin");
});

test("load command with name attempts to load snapshot", () => {
  const prompt = load.getPromptForCommand("my-snapshot");
  assert.ok(prompt.includes("my-snapshot"));
  assert.ok(prompt.includes(".future-code/snapshots/my-snapshot.md"));
  assert.ok(prompt.includes("INSTRUCTIONS"));
});

test("load command without name lists available snapshots", () => {
  const prompt = load.getPromptForCommand("");
  assert.ok(prompt.includes(".future-code/snapshots/"));
  assert.ok(prompt.includes("list"));
  assert.ok(prompt.includes("/save"));
});

test("load command handles missing snapshot gracefully", () => {
  const prompt = load.getPromptForCommand("nonexistent");
  assert.ok(prompt.includes("does not exist") || prompt.includes("check"));
  assert.ok(prompt.includes("available snapshots"));
});

// ─── /watch command ─────────────────────────────────────────────────────────

test("watch command has correct metadata", () => {
  assert.equal(watch.name, "watch");
  assert.equal(watch.type, "prompt");
  assert.ok(watch.description.length > 0);
  assert.ok(watch.argumentHint);
  assert.ok(watch.progressMessage);
  assert.equal(watch.source, "builtin");
});

test("watch command without args shows help", () => {
  const prompt = watch.getPromptForCommand("");
  assert.ok(prompt.includes("/watch"));
  assert.ok(prompt.includes("Examples"));
  assert.ok(prompt.includes("fswatch") || prompt.includes("inotifywait") || prompt.includes("watch"));
});

test("watch command parses glob and action", () => {
  const prompt = watch.getPromptForCommand("src/**/*.ts run tests");
  assert.ok(prompt.includes("src/**/*.ts"));
  assert.ok(prompt.includes("run tests"));
  assert.ok(prompt.includes("WATCH GLOB"));
  assert.ok(prompt.includes("ACTION ON CHANGE"));
});

test("watch command handles complex action descriptions", () => {
  const prompt = watch.getPromptForCommand("*.md reformat and lint markdown files");
  assert.ok(prompt.includes("*.md"));
  assert.ok(prompt.includes("reformat and lint markdown files"));
});

// ─── /learn command ─────────────────────────────────────────────────────────

test("learn command has correct metadata", () => {
  assert.equal(learn.name, "learn");
  assert.equal(learn.type, "prompt");
  assert.ok(learn.description.length > 0);
  assert.ok(learn.argumentHint);
  assert.ok(learn.progressMessage);
  assert.equal(learn.source, "builtin");
});

test("learn command without args analyzes whole codebase", () => {
  const prompt = learn.getPromptForCommand("");
  assert.ok(prompt.includes("project structure"));
  assert.ok(prompt.includes("Architecture"));
  assert.ok(prompt.includes(".future-code/learned.md"));
});

test("learn command with topic searches for it", () => {
  const prompt = learn.getPromptForCommand("retirement mechanism");
  assert.ok(prompt.includes("retirement mechanism"));
  assert.ok(prompt.includes("grep") || prompt.includes("ripgrep"));
  assert.ok(prompt.includes("synthesize") || prompt.includes("Synthesize"));
});

test("learn command saves results to learned.md", () => {
  const prompt = learn.getPromptForCommand("harness architecture");
  assert.ok(prompt.includes(".future-code/learned.md"));
  assert.ok(prompt.includes("harness architecture"));
});

// ─── Integration: command registration in commands.ts ───────────────────────

test("all new commands are registered in commands.ts source", () => {
  // Read commands.ts and verify imports + array registrations exist.
  // We can't import commands.ts directly in Node because it uses bun:bundle
  // and .js→.ts resolution that only Bun supports.
  const source = readFileSync(join(process.cwd(), "src/commands.ts"), "utf-8");

  // Verify imports exist
  assert.ok(source.includes("import goal from './commands/goal/index.js'"), "goal import must exist");
  assert.ok(source.includes("import loop from './commands/loop/index.js'"), "loop import must exist");
  assert.ok(source.includes("import retry from './commands/retry/index.js'"), "retry import must exist");
  assert.ok(source.includes("import save from './commands/save/index.js'"), "save import must exist");
  assert.ok(source.includes("import load from './commands/load/index.js'"), "load import must exist");
  assert.ok(source.includes("import watch from './commands/watch/index.js'"), "watch import must exist");
  assert.ok(source.includes("import learn from './commands/learn/index.js'"), "learn import must exist");

  // Verify they appear in the COMMANDS array
  assert.ok(source.includes("  goal,"), "goal must be in COMMANDS array");
  assert.ok(source.includes("  loop,"), "loop must be in COMMANDS array");
  assert.ok(source.includes("  retry,"), "retry must be in COMMANDS array");
  assert.ok(source.includes("  save,"), "save must be in COMMANDS array");
  assert.ok(source.includes("  load,"), "load must be in COMMANDS array");
  assert.ok(source.includes("  watch,"), "watch must be in COMMANDS array");
  assert.ok(source.includes("  learn,"), "learn must be in COMMANDS array");
});

test("all new commands have unique names", () => {
  const names = [goal.name, loop.name, retry.name, save.name, load.name, watch.name, learn.name];
  const unique = new Set(names);
  assert.equal(names.length, unique.size, "command names must be unique");
});

test("all new commands have non-empty descriptions", () => {
  const cmds = [goal, loop, retry, save, load, watch, learn];
  for (const cmd of cmds) {
    assert.ok(cmd.description.length > 10, `${cmd.name} description too short: "${cmd.description}"`);
  }
});

test("all new commands are prompt type", () => {
  const cmds = [goal, loop, retry, save, load, watch, learn];
  for (const cmd of cmds) {
    assert.equal(cmd.type, "prompt", `${cmd.name} should be prompt type`);
  }
});

test("all new commands have getPromptForCommand function", () => {
  const cmds = [goal, loop, retry, save, load, watch, learn];
  for (const cmd of cmds) {
    assert.equal(typeof cmd.getPromptForCommand, "function", `${cmd.name} must have getPromptForCommand`);
  }
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

test("goal handles unicode in goal description", () => {
  const prompt = goal.getPromptForCommand("构建一个REST API用户管理系统");
  assert.ok(prompt.includes("构建一个REST API用户管理系统"));
});

test("loop handles empty stop condition after stop:", () => {
  const prompt = loop.getPromptForCommand("do work stop:");
  // Should not crash; the stop condition is empty string
  assert.ok(prompt.length > 0);
});

test("save handles names with spaces", () => {
  const prompt = save.getPromptForCommand("my work progress");
  assert.ok(prompt.includes("my work progress"));
});

test("watch handles glob-only with no action", () => {
  const prompt = watch.getPromptForCommand("*.ts");
  // The regex won't match (no second group), should still return something
  assert.ok(prompt.length > 0);
});

test("learn handles special regex chars in topic", () => {
  const prompt = learn.getPromptForCommand("how does ${VARIABLE} interpolation work?");
  assert.ok(prompt.includes("${VARIABLE}"));
});

// ─── Anti-refusal safeguard tests ────────────────────────────────────────────

test("system prompt contains anti-refusal language for task completion", () => {
  const source = readFileSync(join(process.cwd(), "src/constants/prompts.ts"), "utf-8");
  assert.ok(
    source.includes("never ends the session"),
    "system prompt must state that completing a task never ends the session",
  );
  assert.ok(
    source.includes("remain fully available"),
    "system prompt must instruct assistant to remain available after task completion",
  );
  assert.ok(
    source.includes("Do not refuse"),
    "system prompt must explicitly tell assistant not to refuse further instructions",
  );
});

test("goal prompt does NOT contain language suggesting session ends on completion", () => {
  const prompt = goal.getPromptForCommand("some goal");
  // The prompt should not contain language that could be interpreted as "stop responding"
  const refusalPatterns = [
    /session is over/i,
    /no further action/i,
    /task is complete.*stop/i,
    /nothing more to do/i,
  ];
  for (const pattern of refusalPatterns) {
    assert.ok(!pattern.test(prompt), `goal prompt must not contain refusal pattern: ${pattern}`);
  }
});

test("loop prompt does NOT contain language suggesting session ends on completion", () => {
  const prompt = loop.getPromptForCommand("do work stop: done");
  for (const pattern of [
    /session is over/i,
    /no further action/i,
    /nothing more to do/i,
  ]) {
    assert.ok(!pattern.test(prompt), `loop prompt must not contain refusal pattern: ${pattern}`);
  }
});

// ─── Deep anti-refusal: system prompt intro and FUTURE_CODE_SIMPLE ─────────

test("intro section (always included) contains anti-refusal language", () => {
  const source = readFileSync(join(process.cwd(), "src/constants/prompts.ts"), "utf-8");
  // The intro section is getSimpleIntroSection — it must contain the anti-refusal
  // language because it's ALWAYS included, unlike getSimpleDoingTasksSection
  // which can be skipped when keepCodingInstructions is false.
  const introMatch = source.match(/getSimpleIntroSection[\s\S]*?return `[\s\S]*?`/);
  assert.ok(introMatch, "must find getSimpleIntroSection function");
  const intro = introMatch![0];
  assert.ok(
    intro.includes("never ends the session"),
    "intro section must state that completing a task never ends the session",
  );
  assert.ok(
    intro.includes("Never refuse"),
    "intro section must explicitly say 'Never refuse' further instructions",
  );
  assert.ok(
    intro.includes("remain available"),
    "intro section must instruct assistant to remain available",
  );
});

test("FUTURE_CODE_SIMPLE prompt contains anti-refusal language", () => {
  const source = readFileSync(join(process.cwd(), "src/constants/prompts.ts"), "utf-8");
  // The simple prompt path must also contain anti-refusal language
  const simpleMatch = source.match(/FUTURE_CODE_SIMPLE[\s\S]*?return \[[\s\S]*?\]/);
  assert.ok(simpleMatch, "must find FUTURE_CODE_SIMPLE block");
  const simple = simpleMatch![0];
  assert.ok(
    simple.includes("never ends the session"),
    "FUTURE_CODE_SIMPLE prompt must state task completion never ends session",
  );
  assert.ok(
    simple.includes("Never refuse"),
    "FUTURE_CODE_SIMPLE prompt must say 'Never refuse' further instructions",
  );
});

test("ExitPlanMode agent tool result does NOT say 'nothing else needed'", () => {
  const source = readFileSync(join(process.cwd(), "src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts"), "utf-8");
  assert.ok(
    !source.includes("nothing else needed from you now"),
    "ExitPlanMode must NOT tell the agent 'nothing else needed' — this causes the model to refuse further instructions",
  );
  assert.ok(
    !source.includes('Please respond with "ok"'),
    "ExitPlanMode must NOT ask agent to respond with just 'ok' — this signals conversation is over",
  );
  assert.ok(
    source.includes("remain available"),
    "ExitPlanMode agent tool result should tell the agent to remain available for further instructions",
  );
});

test("ExitPlanMode agent tool result tells agent to continue coding", () => {
  const source = readFileSync(join(process.cwd(), "src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts"), "utf-8");
  assert.ok(
    source.includes("You can now start coding"),
    "ExitPlanMode agent tool result should tell the agent to start coding",
  );
});

test("anti-refusal language is in getSimpleIntroSection, not only in getSimpleDoingTasksSection", () => {
  // This is critical: getSimpleDoingTasksSection can be SKIPPED when
  // outputStyleConfig.keepCodingInstructions === false. The anti-refusal
  // language must also be in getSimpleIntroSection which is ALWAYS included.
  const source = readFileSync(join(process.cwd(), "src/constants/prompts.ts"), "utf-8");
  const introMatch = source.match(/function getSimpleIntroSection[\s\S]*?^}/m);
  assert.ok(introMatch, "must find getSimpleIntroSection");
  assert.ok(
    introMatch![0].includes("never ends the session"),
    "getSimpleIntroSection MUST contain anti-refusal language (it's always included)",
  );
});
