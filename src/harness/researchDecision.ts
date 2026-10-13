/** Shared decision discipline for interactive goals and external-API workers. */
export const researchDecisionGuidance =
  "Before substantial work, identify the uncertainty that could change the next action and the cheapest authorized observation that distinguishes the alternatives. " +
  "Evaluate an existing baseline or candidate early; if none is evaluable, build the smallest evaluable artifact first. " +
  "Use observed failures to diagnose, repair, and re-evaluate on a small scale before expanding an expensive build, experiment, or training run. " +
  "State what result would change the plan. Check environmental and interface prerequisites with a minimal reproduction when they are uncertain. " +
  "Measure the intended outcome; tool success and activity alone do not establish progress. " +
  "Fresh applicable evidence can be reused; do not repeatedly evaluate unchanged inputs or defer an actionable failure for unrelated improvements. " +
  "Diagnostics inform decisions; independent acceptance checks still decide completion.";
