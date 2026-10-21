/** Shared reasoning guidance, never an acceptance or execution capability. */
export const DECISION_GUIDANCE = "Before substantial work, identify the uncertainty that could change the next action. " +
  "Evaluate a baseline early; otherwise build the smallest evaluable artifact. " +
  "For sustained experiments, preserve the best verified artifact and evaluation contract; compare new outcomes with it before more compute. " +
  "Prefer small discriminating evaluations and negative controls before costly work. State next actions for different outcomes; plans and hypotheses remain unverified. " +
  "Use failures to diagnose, repair and re-evaluate at small scale. On a plateau, revise the hypothesis or measurement using observed failures; batch independent variants within resource bounds. " +
  "Check uncertain environmental and interface prerequisites with a minimal reproduction. Measure the intended outcome; activity and tool success alone do not establish progress. " +
  "Reuse fresh applicable evidence; avoid reevaluating unchanged inputs or unrelated improvements while an actionable failure remains. " +
  "Use negative results to eliminate hypotheses. Keep simple tasks direct, preserve acceptance and budgets, and reconcile existing external work before replacing it.";
