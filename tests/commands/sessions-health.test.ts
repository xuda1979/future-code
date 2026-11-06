import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanProjectHealth,
  formatProjectHealthReport,
  decodeProjectDirName,
  STALE_SESSION_MS,
  STUCK_GOAL_STALE_MS,
} from "../../src/commands/sessions/sessionsHealth.ts";

function fixture(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "sessions-health-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const HOUR = 60 * 60 * 1000;

/**
 * Builds a fake session store plus the real project working directories the
 * transcripts point at. Returns the store path. Each project spec is
 * { dirName, projectPath, sessions: [{ id, ageHours }], goal? }.
 */
function makeStore(root: string, projects: Array<{
  dirName: string;
  projectPath: string;
  sessions: Array<{ id: string; ageHours: number }>;
  goal?: Record<string, unknown>;
}>): string {
  const store = join(root, "projects");
  mkdirSync(store, { recursive: true });
  for (const spec of projects) {
    const projectDir = join(store, spec.dirName);
    mkdirSync(projectDir, { recursive: true });
    for (const s of spec.sessions) {
      const file = join(projectDir, `${s.id}.jsonl`);
      // First line carries the authoritative cwd, like real transcripts.
      writeFileSync(file, JSON.stringify({ cwd: spec.projectPath, sessionId: s.id }) + "\n");
      const when = new Date(Date.now() - s.ageHours * HOUR);
      utimesSync(file, when, when);
    }
    if (spec.goal) {
      const goalDir = join(spec.projectPath, ".future-code");
      mkdirSync(goalDir, { recursive: true });
      writeFileSync(
        join(goalDir, "goal-autonomy.json"),
        JSON.stringify(spec.goal),
      );
    }
  }
  return store;
}

test("scanProjectHealth returns empty for a missing store", () => {
  const reports = scanProjectHealth({ projectsDir: join(tmpdir(), "does-not-exist-" + Date.now()) });
  assert.deepEqual(reports, []);
});

test("scanProjectHealth collects sessions, recovers exact project paths, and orders by recency", () => {
  fixture(root => {
    const store = makeStore(root, [
      {
        dirName: "-Users-alice-app",
        projectPath: "/Users/alice/app",
        sessions: [
          { id: "aaa", ageHours: 1 },
          { id: "bbb", ageHours: 5 },
        ],
      },
      {
        dirName: "-Users-alice-old",
        projectPath: "/Users/alice/old",
        sessions: [{ id: "ccc", ageHours: 100 }],
      },
    ]);

    const reports = scanProjectHealth({ projectsDir: store });
    assert.equal(reports.length, 2);

    // Most recent project first.
    assert.equal(reports[0]!.project.dirName, "-Users-alice-app");
    const app = reports[0]!.project;
    assert.equal(app.sessions.length, 2);
    assert.equal(app.latestSession!.sessionId, "aaa");
    assert.equal(app.projectPath, "/Users/alice/app");
    assert.equal(app.projectPathExact, true, "cwd recovered from transcript head");
    assert.ok(app.totalBytes > 0);

    const old = reports[1]!.project;
    assert.equal(old.latestSession!.sessionId, "ccc");
    // Old project should carry a stale flag; recent project has none.
    assert.ok(reports[1]!.flags.some(f => f.kind === "stale"), "old project flagged stale");
    assert.deepEqual(reports[0]!.flags, []);
  });
});

test("project paths with hyphens round-trip exactly via transcript cwd, not lossy decode", () => {
  fixture(root => {
    const store = makeStore(root, [
      {
        dirName: "-Users-alice-quantum-gpt",
        projectPath: "/Users/alice/quantum-gpt",
        sessions: [{ id: "s1", ageHours: 0.5 }],
      },
    ]);
    const reports = scanProjectHealth({ projectsDir: store });
    assert.equal(reports[0]!.project.projectPath, "/Users/alice/quantum-gpt");
    assert.equal(reports[0]!.project.projectPathExact, true);
    // The lossy decode would have produced quantum/gpt — proving cwd wins.
    assert.notEqual(decodeProjectDirName("-Users-alice-quantum-gpt"), "/Users/alice/quantum-gpt");
  });
});

test("unreadable transcript falls back to the lossy decode, marked approximate", () => {
  fixture(root => {
    const store = makeStore(root, []);
    const projectDir = join(store, "-Users-alice-approx");
    mkdirSync(projectDir, { recursive: true });
    // A .jsonl with no parseable cwd record.
    const file = join(projectDir, "deadbeef.jsonl");
    writeFileSync(file, "not json at all\n");
    const when = new Date(Date.now() - 2 * HOUR);
    utimesSync(file, when, when);

    const reports = scanProjectHealth({ projectsDir: store });
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.project.projectPath, "/Users/alice/approx");
    assert.equal(reports[0]!.project.projectPathExact, false);
  });
});

test("scanProjectHealth reads goal state from the project's real working directory", () => {
  fixture(root => {
    const projectPath = join(root, "research-workdir");
    mkdirSync(projectPath, { recursive: true });
    const store = makeStore(root, [
      {
        dirName: "-Users-alice-research",
        projectPath,
        sessions: [{ id: "s1", ageHours: 0.5 }],
        goal: {
          goal: "train the model to 100%",
          state: "ACTIVE",
          revision: 7,
          continuations: 2,
          totalContinuations: 6,
        },
      },
    ]);

    const reports = scanProjectHealth({ projectsDir: store });
    assert.equal(reports.length, 1);
    const p = reports[0]!.project;
    assert.equal(p.activeGoal, "train the model to 100%");
    assert.equal(p.goalState, "ACTIVE");
    assert.equal(p.goalRevision, 7);
    assert.deepEqual(p.goalContinuations, { continuations: 2, totalContinuations: 6 });
    // Recent session + ACTIVE goal = no flags.
    assert.deepEqual(reports[0]!.flags, []);
  });
});

test("ACTIVE goal with no recent session is flagged stuck", () => {
  fixture(root => {
    const projectPath = join(root, "wedged-workdir");
    mkdirSync(projectPath, { recursive: true });
    const store = makeStore(root, [
      {
        dirName: "-Users-alice-wedged",
        projectPath,
        sessions: [{ id: "s1", ageHours: 48 }],
        goal: { goal: "never finishes", state: "ACTIVE" },
      },
    ]);

    const reports = scanProjectHealth({ projectsDir: store });
    const kinds = reports[0]!.flags.map(f => f.kind);
    assert.ok(kinds.includes("stuck-active-goal"), `flags: ${kinds.join(",")}`);
    assert.ok(kinds.includes("stale"), "also flagged stale");
  });
});

test("PAUSED goals are never flagged stuck", () => {
  fixture(root => {
    const projectPath = join(root, "paused-workdir");
    mkdirSync(projectPath, { recursive: true });
    const store = makeStore(root, [
      {
        dirName: "-Users-alice-paused",
        projectPath,
        sessions: [{ id: "s1", ageHours: 48 }],
        goal: { goal: "on hold", state: "PAUSED" },
      },
    ]);

    const reports = scanProjectHealth({ projectsDir: store });
    const kinds = reports[0]!.flags.map(f => f.kind);
    assert.ok(!kinds.includes("stuck-active-goal"), `flags: ${kinds.join(",")}`);
  });
});

test("minLatestModifiedMs filters dormant projects", () => {
  fixture(root => {
    const store = makeStore(root, [
      {
        dirName: "-Users-alice-live",
        projectPath: "/Users/alice/live",
        sessions: [{ id: "x", ageHours: 1 }],
      },
      {
        dirName: "-Users-alice-dormant",
        projectPath: "/Users/alice/dormant",
        sessions: [{ id: "y", ageHours: 24 * 40 }],
      },
    ]);

    const recentOnly = scanProjectHealth({
      projectsDir: store,
      minLatestModifiedMs: Date.now() - 30 * 24 * HOUR,
    });
    assert.equal(recentOnly.length, 1);
    assert.equal(recentOnly[0]!.project.dirName, "-Users-alice-live");

    const all = scanProjectHealth({ projectsDir: store });
    assert.equal(all.length, 2);
  });
});

test("largeProjectBytes override controls the large-project flag", () => {
  fixture(root => {
    const store = makeStore(root, [
      {
        dirName: "-Users-alice-app",
        projectPath: "/Users/alice/app",
        sessions: [{ id: "a", ageHours: 2 }],
      },
    ]);

    // Threshold of 1 byte: the fixture's transcript exceeds it.
    const strict = scanProjectHealth({ projectsDir: store, largeProjectBytes: 1 });
    assert.ok(strict[0]!.flags.some(f => f.kind === "large-project"));

    // Default threshold: tiny fixture is fine.
    const normal = scanProjectHealth({ projectsDir: store });
    assert.ok(!normal[0]!.flags.some(f => f.kind === "large-project"));
  });
});

test("scanProjectHealth ignores non-jsonl files in project directories", () => {
  fixture(root => {
    const store = makeStore(root, [
      {
        dirName: "-Users-alice-mixed",
        projectPath: "/Users/alice/mixed",
        sessions: [{ id: "keep", ageHours: 1 }],
      },
    ]);
    const projectDir = join(store, "-Users-alice-mixed");
    writeFileSync(join(projectDir, "README.md"), "not a session");
    writeFileSync(join(projectDir, "notes.txt"), "also not a session");

    const reports = scanProjectHealth({ projectsDir: store });
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.project.sessions.length, 1);
    assert.equal(reports[0]!.project.sessions[0]!.sessionId, "keep");
  });
});

test("decodeProjectDirName is the documented lossy fallback", () => {
  assert.equal(decodeProjectDirName("-tmp"), "/tmp");
  assert.equal(decodeProjectDirName("plain"), "plain");
  // Lossy by design: hyphens and separators are indistinguishable.
  assert.equal(decodeProjectDirName("-a-b-c"), "/a/b/c");
});

test("formatProjectHealthReport renders a readable multi-project summary", () => {
  fixture(root => {
    const store = makeStore(root, [
      {
        dirName: "-Users-alice-app",
        projectPath: "/Users/alice/app",
        sessions: [{ id: "a", ageHours: 2 }],
      },
      {
        dirName: "-Users-alice-old",
        projectPath: "/Users/alice/old",
        sessions: [{ id: "b", ageHours: 100 }],
      },
    ]);

    const reports = scanProjectHealth({ projectsDir: store });
    const text = formatProjectHealthReport(reports);
    assert.match(text, /Session health across all projects/);
    assert.match(text, /\/Users\/alice\/app: 1 session\(s\)/);
    assert.match(text, /2h ago/);
    assert.match(text, /!/);
  });
});

test("formatProjectHealthReport explains an empty store", () => {
  assert.equal(
    formatProjectHealthReport([]),
    "No projects found in the session store.",
  );
});

test("constants encode the intended health policy", () => {
  assert.equal(STALE_SESSION_MS, 24 * 60 * 60 * 1000);
  assert.equal(STUCK_GOAL_STALE_MS, 6 * 60 * 60 * 1000);
});
