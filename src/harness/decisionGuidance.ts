/** Shared reasoning guidance, never an acceptance or execution capability. */
export const DECISION_GUIDANCE = "Before substantial work, identify the uncertainty that could change the next action. " +
  "Prefer an available small evaluation or discriminating experiment when its result can prevent wasted implementation or compute. " +
  "Evaluate an existing baseline or candidate early; if none is evaluable, build the smallest evaluable artifact first. " +
  "Use observed failures to diagnose, repair, and re-evaluate on a small scale before expanding an expensive build, experiment, or training run. " +
  "State what different outcomes would make you do next; hypotheses and plans remain unverified. " +
  "Revisit the approach when evidence changes or work expands without useful measurement. " +
  "Check uncertain environmental and interface prerequisites with a minimal reproduction. Measure the intended outcome; tool success and activity alone do not establish progress. " +
  "Reuse fresh applicable evidence; do not repeatedly evaluate unchanged inputs or defer an actionable failure for unrelated improvements. " +
  "Use negative results to eliminate hypotheses. Keep straightforward tasks direct, preserve acceptance and budgets, and reconcile existing external work before replacing it.";
