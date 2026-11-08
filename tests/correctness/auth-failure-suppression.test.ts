/**
 * Unit tests for auth-failure transcript suppression
 * (src/utils/authFailureSuppression.ts).
 *
 * The feature: a non-interactive run whose only assistant output is a
 * synthetic authentication_failed error gets its transcript pruned at
 * cleanup, replaced by a one-line marker in ~/.future/auth-failures.jsonl.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import {
  markAuthFailureDetected,
  pruneAuthFailOnlyTranscript,
  resetAuthFailureSuppressionForTesting,
} from "../../src/utils/authFailureSuppression.js";

const SESSION_ID = "test-session-0001";
const CWD = "/tmp/fake-project";

function makeTranscript(opts?: {
  withToolUse?: boolean;
  withRealAssistant?: boolean;
  authFail?: boolean;
}): string {
  const lines: string[] = [
    '{"type":"queue-operation","operation":"enqueue"}',
    '{"type":"user","message":{"content":"continue research and development"}}',
  ];
  if (opts?.withToolUse) {
    lines.push(
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]},"isApiErrorMessage":true}',
    );
  } else if (opts?.withRealAssistant) {
    lines.push(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}',
    );
  } else if (opts?.authFail !== false) {
    lines.push(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Not logged in"}]},"isApiErrorMessage":true}',
    );
  }
  return lines.join("\n") + "\n";
}

describe("pruneAuthFailOnlyTranscript", () => {
  beforeEach(() => {
    resetAuthFailureSuppressionForTesting();
  });

  test("prunes auth-fail-only transcript in non-interactive mode", () => {
    markAuthFailureDetected();
    let unlinked = false;
    const path = pruneAuthFailOnlyTranscript({
      isNonInteractive: true,
      transcriptPath: "/tmp/sess.jsonl",
      sessionId: SESSION_ID,
      cwd: CWD,
      readFile: () => makeTranscript(),
      unlink: p => {
        expect(p).toBe("/tmp/sess.jsonl");
        unlinked = true;
      },
    });
    expect(path).toBe("/tmp/sess.jsonl");
    expect(unlinked).toBe(true);
  });

  test("keeps transcript when tool use happened", () => {
    markAuthFailureDetected();
    let unlinked = false;
    const path = pruneAuthFailOnlyTranscript({
      isNonInteractive: true,
      transcriptPath: "/tmp/sess.jsonl",
      sessionId: SESSION_ID,
      cwd: CWD,
      readFile: () => makeTranscript({ withToolUse: true }),
      unlink: () => {
        unlinked = true;
      },
    });
    expect(path).toBeUndefined();
    expect(unlinked).toBe(false);
  });

  test("keeps transcript when a real assistant message exists", () => {
    markAuthFailureDetected();
    let unlinked = false;
    const path = pruneAuthFailOnlyTranscript({
      isNonInteractive: true,
      transcriptPath: "/tmp/sess.jsonl",
      sessionId: SESSION_ID,
      cwd: CWD,
      readFile: () => makeTranscript({ withRealAssistant: true }),
      unlink: () => {
        unlinked = true;
      },
    });
    expect(path).toBeUndefined();
    expect(unlinked).toBe(false);
  });

  test("does not prune interactive sessions", () => {
    markAuthFailureDetected();
    const path = pruneAuthFailOnlyTranscript({
      isNonInteractive: false,
      transcriptPath: "/tmp/sess.jsonl",
      sessionId: SESSION_ID,
      cwd: CWD,
      readFile: () => makeTranscript(),
      unlink: () => {
        throw new Error("must not unlink");
      },
    });
    expect(path).toBeUndefined();
  });

  test("does not prune when no auth failure was detected", () => {
    const path = pruneAuthFailOnlyTranscript({
      isNonInteractive: true,
      transcriptPath: "/tmp/sess.jsonl",
      sessionId: SESSION_ID,
      cwd: CWD,
      readFile: () => makeTranscript(),
      unlink: () => {
        throw new Error("must not unlink");
      },
    });
    expect(path).toBeUndefined();
  });

  test("missing transcript file is a no-op", () => {
    markAuthFailureDetected();
    const path = pruneAuthFailOnlyTranscript({
      isNonInteractive: true,
      transcriptPath: "/tmp/sess.jsonl",
      sessionId: SESSION_ID,
      cwd: CWD,
      readFile: () => {
        throw new Error("ENOENT");
      },
      unlink: () => {
        throw new Error("must not unlink");
      },
    });
    expect(path).toBeUndefined();
  });

  test("prune happens at most once per process", () => {
    markAuthFailureDetected();
    let count = 0;
    const opts = {
      isNonInteractive: true,
      transcriptPath: "/tmp/sess.jsonl",
      sessionId: SESSION_ID,
      cwd: CWD,
      readFile: () => makeTranscript(),
      unlink: () => {
        count++;
      },
    } as const;
    expect(pruneAuthFailOnlyTranscript(opts)).toBe("/tmp/sess.jsonl");
    expect(pruneAuthFailOnlyTranscript(opts)).toBeUndefined();
    expect(count).toBe(1);
  });
});
