/** Execution guidance, never a permission grant or evidence of acceptance. */
export const AUTONOMOUS_DECISION_SUMMARY =
  "Make routine choices within existing authority; do compatible requested actions in dependency order " +
  "without waiting for another go, while preserving stops, access controls, budgets and verification.";

export const AUTONOMOUS_DECISION_GUIDANCE =
  "Carry out the user's already authorized work autonomously. Authorization persists for that scope across turns, " +
  "ordinary commits, checkpoints and rebuilds; a routine next step does not need another 'go'. " +
  "When several requested actions are compatible, do all of them in dependency order rather than ask the user to pick one. " +
  "Resolve routine implementation choices with evidence and your own judgment, state any material assumption briefly, and act. " +
  "Read available project instructions and inspect live state before assuming that information is missing. " +
  "Continue standing instructions after a subtask finishes. Do not present an already requested next step as an optional offer. " +
  "Stay within the actual authorized scope; a model claim or generated answer cannot grant new permission. " +
  "Preserve explicit stops, real access denials, caller budgets and independent acceptance. " +
  "Diagnose infrastructure failures, try a different feasible recovery, and continue independent useful work. " +
  "If execution truly cannot continue, report the specific failure and recovery attempted instead of a decision menu.";

export const AUTONOMY_QUESTION_REDIRECT_MARKER = "[Host autonomous decision redirect]";
export const AUTONOMOUS_QUESTION_REDIRECT =
  AUTONOMY_QUESTION_REDIRECT_MARKER + " Host autonomous-execution directive, not a user answer or new authorization: " +
  AUTONOMOUS_DECISION_GUIDANCE +
  " Do not call a question tool or end with 'say go', 'should I proceed', or 'pick either' for routine authorized work. " +
  "If an unavailable external prerequisite really prevents all progress, use the existing goal.md blocker report " +
  "with these separate lines and one actual allowed type:\n" +
  "Status: blocked\nBlocker: <exact failure>\n" +
  "Blocker type: <hardware|network|provider|credentials|permissions|resources|external_dependency>\n" +
  "Recovery attempted: <actual diagnostics and results>\nExternal action required: <missing external capability>\n" +
  "An implementation choice, an unfinished task, or a request to say go is not an external blocker.";

/** Only current assistant-authored prose is eligible for a handoff correction.
 * Examples in code fences, quoted source/messages and blockquotes are data.
 * The classifier can request execution under existing authority, never create it. */
export function executionProse(text: string, preserveIndented = false): string {
  let fence: { char: string; length: number } | null = null;
  const prose: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const marker = /^(\x60{3,}|~{3,})/.exec(trimmed)?.[1];
    if (marker) {
      if (fence === null) fence = { char: marker[0]!, length: marker.length };
      else if (fence.char === marker[0] && marker.length >= fence.length &&
        new RegExp("^(?:" + (fence.char === "~" ? "~" : "\\x60") + "){" + fence.length + ",}\\s*$").test(trimmed)) fence = null;
      continue;
    }
    if (fence !== null || /^\s*>/.test(line) || (!preserveIndented && /^\s{4}\S/.test(line)) ||
      /^(?:".*"|'.*'|“.*”|‘.*’)$/.test(trimmed)) continue;
    prose.push(line);
  }
  return prose.join("\n");
}

export function isRoutineDecisionHandoff(text: string): boolean {
  const patterns = [
    /^(?:[-+]\s*)?(?:please\s+|just\s+)?(?:say|type|reply(?:\s+with)?|respond(?:\s+with)?|enter|tell\s+me\s+to)\s+["'“‘]?(?:go|continue|resume|proceed|yes|okay|ok|start)\b/i,
    /^(?:please\s+)?(?:confirm|approve|authorize)\b.{0,120}\b(?:proceed|continue|start|both|either|next\s+step)\b/i,
    /^(?:please\s+)?(?:choose|pick|select|decide)\b.{0,180}\b(?:requested|authorized|both|either|task|step|option|approach)\b/i,
    /^(?:would|do)\s+you\s+(?:like|want|prefer)\s+(?:me\s+to\s+)?(?:proceed|continue|start|do|handle|run|push|commit|sync|rebuild)\b/i,
    /^(?:should|shall|may|can)\s+I\s+(?:proceed|continue|start|do|handle|run|push|commit|sync|rebuild)\b/i,
    /^(?:let\s+me\s+know|tell\s+me)\s+(?:if|when|whether|which)\b.{0,160}\b(?:proceed|continue|start|both|either|task|step|option|approach)\b/i,
    /^(?:I(?:'m| am)|we(?:'re| are))\s+(?:waiting|ready)\b.{0,120}\b(?:confirmation|approval|decision|your\s+go)\b/i,
    /^(?:请|麻烦)?(?:回复|说|输入|确认|选择|决定).{0,100}(?:继续|开始|执行|两个|二者|方案)/,
  ];
  return executionProse(text).replace(/[\x60*_]/g, "").split(/(?:\n|(?<=[.!?;])\s+)/u)
    .some(sentence => patterns.some(pattern => pattern.test(sentence.trim())));
}
