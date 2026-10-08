/**
 * Conditional, quality-adjusted productivity forecasts. These are workload
 * assumptions, not empirical measurements or claims about other agents.
 * No external model, hidden speedup factor, or network access is used.
 */
import type {Task} from './types.ts';
import type {SwarmSpec} from './swarm/config.ts';

export interface ProductivityArm {
  workers: number;
  coordinationHours: number;
  lostWorkHours: number;
  verifiedCompletionProbability: number;
}
export interface ProductivityScenario {
  workHours: number;
  serialFraction: number;
  baseline: ProductivityArm;
  futureCode: ProductivityArm;
}

const numeric = (value: number, label: string, lower: number, upper = Infinity): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < lower || value > upper)
    throw new Error(`${label} must be finite and in [${lower}, ${upper}]`);
  return value;
};

function arm(name: string, value: ProductivityArm): ProductivityArm {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${name} missing`);
  return {
    workers: numeric(value.workers, `${name}.workers`, 1),
    coordinationHours: numeric(value.coordinationHours, `${name}.coordinationHours`, 0),
    lostWorkHours: numeric(value.lostWorkHours, `${name}.lostWorkHours`, 0),
    verifiedCompletionProbability: numeric(value.verifiedCompletionProbability,
      `${name}.verifiedCompletionProbability`, 0, 1),
  };
}

export function predictProductivity(scenario: ProductivityScenario) {
  if (!scenario || typeof scenario !== 'object') throw new Error('scenario missing');
  const workHours = numeric(scenario.workHours, 'workHours', Number.EPSILON);
  const serialFraction = numeric(scenario.serialFraction, 'serialFraction', 0, 1);
  const baseline = arm('baseline', scenario.baseline);
  const futureCode = arm('futureCode', scenario.futureCode);
  const time = (a: ProductivityArm) => workHours * (serialFraction + (1 - serialFraction) / a.workers) +
    a.coordinationHours + a.lostWorkHours;
  const baselineHours = time(baseline);
  const futureCodeHours = time(futureCode);
  const parallelismBenefitHours = workHours * (1 - serialFraction) *
    (1 / baseline.workers - 1 / futureCode.workers);
  const avoidedLostWorkHours = baseline.lostWorkHours - futureCode.lostWorkHours;
  const extraCoordinationHours = futureCode.coordinationHours - baseline.coordinationHours;
  const breakEvenMarginHours = parallelismBenefitHours + avoidedLostWorkHours - extraCoordinationHours;
  const speedup = baselineHours / futureCodeHours;
  const bq = baseline.verifiedCompletionProbability;
  const fq = futureCode.verifiedCompletionProbability;
  const qualityAdjustedSpeedup = bq > 0 ? (fq / futureCodeHours) / (bq / baselineHours) : null;
  return {
    kind: 'CONDITIONAL_FORECAST_ONLY',
    baselineHours, futureCodeHours, speedup,
    verifiedObjectivesPerHour: { baseline: bq / baselineHours, futureCode: fq / futureCodeHours },
    qualityAdjustedSpeedup,
    breakEven: { parallelismBenefitHours, avoidedLostWorkHours,
      extraCoordinationHours, breakEvenMarginHours,
      futureFasterByTime: breakEvenMarginHours > 0 },
    target2x: qualityAdjustedSpeedup === null ? 'UNKNOWN_BASELINE_QUALITY' :
      qualityAdjustedSpeedup >= 2 ? 'CONDITIONAL_GE_2X' : 'NOT_DEMONSTRATED',
    warning: 'Assumptions supplied by caller; this is not an observed Claude Code, Codex, or Future-Code result.',
  };
}

/** Advisory only: does not change the authority, verifier, or budget. */
export function recommendExecutionLane(tasks: Task[], spec: SwarmSpec) {
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('tasks missing');
  if (!spec || !spec.agents || !spec.defaultAgent) throw new Error('swarm spec missing');
  const reason = (value: string) => ({ lane: 'supervised', reason: value,
    entrypoint: 'swarm supervise --objective ID --goal GOAL.txt --tasks TASKS.json --allow-exec' });
  if (tasks.length !== 1) return reason('multiple tasks require durable integration and recovery');
  const task = tasks[0];
  if (!Array.isArray(task.dependencies) || task.dependencies.length) return reason('task has dependencies');
  const agent = spec.agents[task.agent ?? spec.defaultAgent];
  if (!agent || !Array.isArray(agent.tools)) throw new Error('task agent is not configured');
  if (spec.jobs || spec.workers || spec.supervision?.dynamicDAG ||
      agent.tools.includes('run_job') || agent.tools.includes('spawn_tasks') ||
      (agent.jobs?.length ?? 0) > 0)
    return reason('remote job, fleet or dynamic expansion capability requires supervision');
  if (task.estimatedDurationMs !== undefined &&
      numeric(task.estimatedDurationMs, 'estimatedDurationMs', 1) > 120000)
    return reason('estimated work exceeds two minutes');
  return {lane: 'direct', reason: 'one local bounded task with no remote or spawn capability',
    entrypoint: 'swarm run --tasks TASKS.json --allow-exec; then swarm integrate --run RUN_ID --allow-exec',
    caution: 'Keep independent checks and final integration. For unbounded research, opt into supervise.'};
}
