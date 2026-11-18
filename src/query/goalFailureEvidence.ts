/** Execution-local provenance for model-authored blocker reports. Only actual
 * paired error receipts enter this bounded list; prose, question redirects and
 * earlier objectives cannot supply an external failure. No acceptance grant. */
interface Goal { goal: string; revision?: number; activeSteering?: string[]; state: string }
interface Message { type: string; origin?: unknown; message?: { content?: unknown } }
interface Call { id: string; name: string }
const MAX_RECEIPTS = 32;
const MAX_BLOCKS = 256;
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'EnterPlanMode']);
function version(goal: Goal | null): string | null {
  return goal?.state === 'ACTIVE' ? JSON.stringify([goal.goal, goal.revision ?? 1, goal.activeSteering ?? []]) : null;
}

export class GoalFailureEvidence {
  private scope: string | null = null;
  private ids: string[] = [];

  forGoal(goal: Goal | null): string[] {
    const scope = version(goal);
    if (scope !== this.scope || scope === null) { this.scope = scope; this.ids = []; }
    return [...this.ids];
  }

  record(goal: Goal | null, calls: readonly Call[], results: readonly Message[]): void {
    this.forGoal(goal);
    if (!this.scope || calls.length > MAX_BLOCKS || results.length > MAX_BLOCKS) return;
    const names = new Map<string, string>();
    const duplicates = new Set<string>();
    for (const call of calls) {
      if (names.has(call.id)) duplicates.add(call.id);
      if (typeof call.id === 'string' && call.id.length <= 256 && typeof call.name === 'string') names.set(call.id, call.name);
    }
    const counts = new Map<string, number>();
    const failed = new Set<string>();
    for (const result of results) {
      if (result.type !== 'user' || result.origin !== undefined || !Array.isArray(result.message?.content) ||
        result.message.content.length > MAX_BLOCKS) continue;
      for (const block of result.message.content) {
        if (!block || typeof block !== 'object' || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const id = block.tool_use_id;
        counts.set(id, (counts.get(id) ?? 0) + 1);
        if (block.is_error === true) failed.add(id);
      }
    }
    for (const id of failed) {
      const name = names.get(id);
      if (!name || QUESTION_TOOLS.has(name) || duplicates.has(id) || counts.get(id) !== 1 || this.ids.includes(id)) continue;
      this.ids.push(id);
      if (this.ids.length > MAX_RECEIPTS) this.ids.shift();
    }
  }
}
