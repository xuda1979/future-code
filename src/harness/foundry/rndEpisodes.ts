import { canonical, digest, invariant } from "./kernel.ts";
import { taskExperienceSignature } from "./evidenceFabric.ts";
import type { Store } from "./store.ts";
import type { Json, Task } from "./types.ts";
import type { PinnedSwarm } from "./swarm/config.ts";
import { externalEffectSnapshot, objectiveJobUsage } from "./swarm/jobs.ts";
import { reflectionHistory } from "./rndReflection.ts";
import { interventionHistory } from "./interventionMemory.ts";

const json = (value: unknown): Json => JSON.parse(canonical(value)) as Json;
const hashText = (value: unknown): string => digest(value);

export interface BuiltObjectiveEpisode {
  episodeHash: string;
  graphHash: string;
}

function tableExists(store: Store, name: string): boolean {
  return !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

export function installRndEpisodeTables(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS rnd_objective_episodes(
    objective TEXT PRIMARY KEY, run TEXT NOT NULL, episode_hash TEXT NOT NULL,
    graph_hash TEXT NOT NULL, schema INTEGER NOT NULL, created REAL NOT NULL);
    CREATE TRIGGER IF NOT EXISTS rnd_objective_episodes_immutable_update
      BEFORE UPDATE ON rnd_objective_episodes BEGIN SELECT RAISE(ABORT,'append-only R&D episode'); END;
    CREATE TRIGGER IF NOT EXISTS rnd_objective_episodes_immutable_delete
      BEFORE DELETE ON rnd_objective_episodes BEGIN SELECT RAISE(ABORT,'append-only R&D episode'); END;`);
}

function objectiveRunSql(): string {
  return `run IN (
    SELECT run FROM swarm_objective_revisions WHERE objective=?
    UNION SELECT run FROM swarm_objectives WHERE id=? AND run IS NOT NULL
  )`;
}

function nullableSum(rows: Record<string, any>[], key: string): number | null {
  if (!rows.length) return 0;
  if (rows.some(row => row[key] === null || !Number.isFinite(Number(row[key])))) return null;
  return rows.reduce((sum, row) => sum + Number(row[key]), 0);
}

function requestGroups(store: Store, run: string, task?: string): Json[] {
  if (!tableExists(store, "agent_requests")) return [];
  const rows = task === undefined
    ? store.db.prepare(`SELECT provider,status,COUNT(*) AS requests,COALESCE(SUM(bytes),0) AS bytes,
        SUM(tokens) AS tokens,COALESCE(SUM(CASE WHEN tokens IS NULL THEN 1 ELSE 0 END),0) AS unknown_tokens
        FROM agent_requests WHERE run=? GROUP BY provider,status ORDER BY provider,status`).all(run)
    : store.db.prepare(`SELECT provider,status,COUNT(*) AS requests,COALESCE(SUM(bytes),0) AS bytes,
        SUM(tokens) AS tokens,COALESCE(SUM(CASE WHEN tokens IS NULL THEN 1 ELSE 0 END),0) AS unknown_tokens
        FROM agent_requests WHERE run=? AND task=? GROUP BY provider,status ORDER BY provider,status`).all(run, task);
  return rows.map(row => json({
    providerHash: String(row.provider), status: String(row.status), requests: Number(row.requests),
    requestBytes: Number(row.bytes),
    tokens: Number(row.unknown_tokens) ? null : Number(row.tokens ?? 0),
    unknownTokenRequests: Number(row.unknown_tokens),
  }));
}

function runResourceSummary(store: Store, run: string): Json {
  const attempts = store.db.prepare("SELECT status,duration,tokens,cost FROM attempts WHERE run=? ORDER BY task,fence").all(run);
  const requestRows = tableExists(store, "agent_requests")
    ? store.db.prepare("SELECT bytes,tokens,status FROM agent_requests WHERE run=?").all(run) : [];
  const jobs = tableExists(store, "research_jobs")
    ? store.db.prepare("SELECT status FROM research_jobs WHERE run=? ORDER BY key").all(run) : [];
  const runRow = store.db.prepare("SELECT started,ended FROM runs WHERE id=?").get(run);
  const requestTokens = requestRows.length && requestRows.some(row => row.tokens === null)
    ? null : requestRows.reduce((sum, row) => sum + Number(row.tokens ?? 0), 0);
  return json({
    durationMs: Math.max(0, Number(runRow?.ended ?? Date.now()) - Number(runRow?.started ?? Date.now())),
    attempts: attempts.length,
    failedAttempts: attempts.filter(row => ["FAIL", "EXPIRED"].includes(String(row.status))).length,
    attemptDurationMs: attempts.reduce((sum, row) => sum + Number(row.duration ?? 0), 0),
    attemptTokens: nullableSum(attempts, "tokens"),
    attemptCostUsd: nullableSum(attempts, "cost"),
    modelRequests: requestRows.length,
    requestBytes: requestRows.reduce((sum, row) => sum + Number(row.bytes ?? 0), 0),
    providerTokens: requestTokens,
    unknownProviderTokenRequests: requestRows.filter(row => row.tokens === null).length,
    externalJobs: jobs.length,
    externalJobStatus: Object.fromEntries([...new Set(jobs.map(row => String(row.status)))].sort()
      .map(status => [status, jobs.filter(row => String(row.status) === status).length])),
  });
}

function profileHashes(cfg: PinnedSwarm, task: Task): { agentRef: string; profileHash: string; modelClassHash: string } {
  const name = task.agent ?? cfg.spec.defaultAgent;
  const profile = cfg.spec.agents[name];
  invariant(profile, "episode task references unknown agent profile");
  return {
    agentRef: digest({ agent: name }),
    profileHash: digest({
      protocol: profile.protocol, model: profile.model,
      tools: [...profile.tools].sort(), checks: [...profile.checks].sort(),
      jobs: [...(profile.jobs ?? [])].sort(), promptCache: profile.promptCache ?? false,
    }),
    modelClassHash: digest({ protocol: profile.protocol, model: profile.model }),
  };
}

function taskSnapshot(store: Store, cfg: PinnedSwarm, domain: string, run: string, row: Record<string, any>,
  externalJobs: Record<string, any>[]): Json {
  const task = JSON.parse(String(row.spec)) as Task;
  const taskRef = digest({ run, task: task.id });
  const profiles = profileHashes(cfg, task);
  const attempts = store.db.prepare(`SELECT a.fence,a.status,a.duration,a.tokens,a.cost,
      m.context_bytes,m.progress_count,m.failure_fingerprint
    FROM attempts a LEFT JOIN attempt_telemetry m
      ON a.run=m.run AND a.task=m.task AND a.fence=m.fence
    WHERE a.run=? AND a.task=? ORDER BY a.fence`).all(run, task.id).map(attempt => json({
      attemptRef: digest({ taskRef, fence: Number(attempt.fence) }),
      fence: Number(attempt.fence), status: String(attempt.status),
      durationMs: Number(attempt.duration ?? 0),
      tokens: attempt.tokens === null ? null : Number(attempt.tokens),
      costUsd: attempt.cost === null ? null : Number(attempt.cost),
      contextBytes: attempt.context_bytes === null ? null : Number(attempt.context_bytes),
      progressCount: Number(attempt.progress_count ?? 0),
      failureFingerprint: attempt.failure_fingerprint == null ? null : String(attempt.failure_fingerprint),
    }));
  const evidence = store.db.prepare(`SELECT id,kind,verdict,strength,artifact_hash,evidence_hash,source
    FROM fabric_evidence WHERE run=? AND task=? ORDER BY created,id`).all(run, task.id).map(item => json({
      evidenceRef: String(item.id), kind: String(item.kind), verdict: String(item.verdict),
      strength: Number(item.strength), artifactHash: item.artifact_hash == null ? null : String(item.artifact_hash),
      evidenceHash: item.evidence_hash == null ? null : String(item.evidence_hash),
      sourceHash: digest(String(item.source)),
    }));
  const experience = store.db.prepare(`SELECT outcome,duration,tokens,cost,strategy_hash,evidence_strength
    FROM fabric_experience WHERE run=? AND task=? ORDER BY created DESC LIMIT 1`).get(run, task.id);
  const allocation = store.db.prepare(`SELECT criticality,uncertainty,evidence_strength,experience_yield,novelty,
      repeated_failure,resource_spent,score FROM fabric_allocations WHERE run=? AND task=?`).get(run, task.id);
  const jobs = externalJobs.filter(job => String(job.run) === run && String(job.task) === task.id).map(job => json({
    jobRef: String(job.key),
    templateHash: digest(String(job.template)),
    jobIdHash: job.jobId == null ? null : digest(String(job.jobId)),
    status: String(job.status), inputHash: String(job.inputHash),
    resultHash: job.resultHash == null ? null : String(job.resultHash),
    reconciliationHash: job.reconciliationHash == null ? null : String(job.reconciliationHash),
  }));
  return json({
    taskRef, signature: taskExperienceSignature(task, domain), specHash: digest(task),
    status: String(row.status),
    errorHash: row.error == null ? null : digest(String(row.error)),
    artifactHash: row.artifact == null ? null : String(row.artifact),
    evidenceHash: row.evidence == null ? null : String(row.evidence),
    dependencies: task.dependencies.map(id => digest({ run, task: id })).sort(),
    ...profiles,
    attempts, requests: requestGroups(store, run, task.id), evidence, externalJobs: jobs,
    experience: experience ? json({
      outcome: String(experience.outcome), durationMs: Number(experience.duration),
      tokens: experience.tokens === null ? null : Number(experience.tokens),
      costUsd: experience.cost === null ? null : Number(experience.cost),
      strategyHash: String(experience.strategy_hash), evidenceStrength: Number(experience.evidence_strength),
    }) : null,
    allocation: allocation ? json({
      criticality: Number(allocation.criticality), uncertainty: Number(allocation.uncertainty),
      evidenceStrength: Number(allocation.evidence_strength), experienceYield: Number(allocation.experience_yield),
      novelty: Number(allocation.novelty), repeatedFailure: Number(allocation.repeated_failure),
      resourceSpent: Number(allocation.resource_spent), score: Number(allocation.score),
    }) : null,
  });
}

function objectiveResources(store: Store, objective: string, externalJobs: Record<string, any>[], cfg: PinnedSwarm): Json {
  const clause = objectiveRunSql();
  const requests = tableExists(store, "agent_requests")
    ? store.db.prepare(`SELECT bytes,tokens,status FROM agent_requests WHERE ${clause}`).all(objective, objective) : [];
  const attempts = store.db.prepare(`SELECT duration,tokens,cost,status FROM attempts WHERE ${clause}`).all(objective, objective);
  const span = store.db.prepare(`SELECT MIN(started) AS first,MAX(COALESCE(ended,started)) AS last FROM runs WHERE id IN (
    SELECT run FROM swarm_objective_revisions WHERE objective=?
    UNION SELECT run FROM swarm_objectives WHERE id=? AND run IS NOT NULL
  )`).get(objective, objective);
  const budget = store.db.prepare("SELECT max_requests,max_request_bytes FROM swarm_objective_budgets WHERE objective=?").get(objective);
  const jobBudget = objectiveJobUsage(store, cfg, objective).map(item => json({
    templateHash: digest(item.template), used: item.used, unresolved: item.unresolved,
    maxPerRun: item.maxPerRun, maxObjectiveJobs: item.maxObjectiveJobs,
  }));
  return json({
    wallClockMs: span?.first == null ? 0 : Math.max(0, Number(span.last) - Number(span.first)),
    attempts: attempts.length, failedAttempts: attempts.filter(row => ["FAIL", "EXPIRED"].includes(String(row.status))).length,
    attemptDurationMs: attempts.reduce((sum, row) => sum + Number(row.duration ?? 0), 0),
    attemptTokens: nullableSum(attempts, "tokens"), attemptCostUsd: nullableSum(attempts, "cost"),
    modelRequests: requests.length, requestBytes: requests.reduce((sum, row) => sum + Number(row.bytes ?? 0), 0),
    providerTokens: requests.length && requests.some(row => row.tokens === null)
      ? null : requests.reduce((sum, row) => sum + Number(row.tokens ?? 0), 0),
    unknownProviderTokenRequests: requests.filter(row => row.tokens === null).length,
    externalJobs: externalJobs.length,
    objectiveRequestBudget: budget ? json({
      maxRequests: Number(budget.max_requests), maxRequestBytes: Number(budget.max_request_bytes),
      usedRequests: requests.length, usedRequestBytes: requests.reduce((sum, row) => sum + Number(row.bytes ?? 0), 0),
    }) : null,
    objectiveJobBudget: jobBudget,
  });
}

function eventKindCounts(store: Store, objective: string): Json {
  const clause = objectiveRunSql();
  const rows = store.db.prepare(`SELECT kind,COUNT(*) AS n FROM events WHERE ${clause} GROUP BY kind ORDER BY kind`)
    .all(objective, objective);
  return json(Object.fromEntries(rows.map(row => [String(row.kind), Number(row.n)])));
}

function buildOutcomeGraph(objectiveRef: string, domain: string, revisions: Record<string, any>[],
  recoveryRows: Record<string, any>[], externalJobs: Record<string, any>[],
  reflections: { run: string; hash: string; reflection: Json }[], completionBinding: string): Json {
  const nodes: Json[] = []; const edges: Json[] = [];
  const objectiveNode = `objective:${objectiveRef}`;
  nodes.push(json({ id: objectiveNode, type: "objective", domain, outcome: "PASS", completionBinding }));
  const runRefByRaw = new Map<string, string>();
  const revisionNodeByNumber = new Map<number, string>();
  for (const revision of revisions) {
    const revisionNode = `revision:${objectiveRef}:${revision.revision}`;
    const runNode = `run:${revision.runRef}`;
    revisionNodeByNumber.set(Number(revision.revision), revisionNode);
    runRefByRaw.set(String(revision.rawRun), String(revision.runRef));
    nodes.push(json({ id: revisionNode, type: "revision", revision: Number(revision.revision),
      planHash: String(revision.planHash), reasonHash: String(revision.reasonHash) }));
    nodes.push(json({ id: runNode, type: "run", status: String(revision.status),
      durationMs: Number(revision.durationMs), recipeHash: String(revision.recipeHash),
      contractHash: String(revision.contractHash) }));
    edges.push(json({ from: objectiveNode, to: revisionNode, kind: "HAS_REVISION" }));
    edges.push(json({ from: revisionNode, to: runNode, kind: "EXECUTED_AS" }));
    for (const task of revision.tasks as Record<string, any>[]) {
      const taskNode = `task:${task.taskRef}`;
      nodes.push(json({ id: taskNode, type: "task", signature: task.signature, status: task.status,
        agentRef: task.agentRef, profileHash: task.profileHash, modelClassHash: task.modelClassHash }));
      edges.push(json({ from: runNode, to: taskNode, kind: "CONTAINS" }));
      for (const dependency of task.dependencies as string[])
        edges.push(json({ from: taskNode, to: `task:${dependency}`, kind: "DEPENDS_ON" }));
      for (const attempt of task.attempts as Record<string, any>[]) {
        const attemptNode = `attempt:${attempt.attemptRef}`;
        nodes.push(json({ id: attemptNode, type: "attempt", status: attempt.status, durationMs: attempt.durationMs,
          tokens: attempt.tokens, costUsd: attempt.costUsd, failureFingerprint: attempt.failureFingerprint }));
        edges.push(json({ from: taskNode, to: attemptNode, kind: "ATTEMPTED" }));
      }
      for (const evidence of task.evidence as Record<string, any>[]) {
        const evidenceNode = `evidence:${evidence.evidenceRef}`;
        nodes.push(json({ id: evidenceNode, type: "evidence", kind: evidence.kind, verdict: evidence.verdict,
          strength: evidence.strength, sourceHash: evidence.sourceHash }));
        edges.push(json({ from: taskNode, to: evidenceNode, kind: "SUPPORTED_BY" }));
      }
      for (const request of task.requests as Record<string, any>[]) {
        const providerNode = `provider:${request.providerHash}`;
        if (!nodes.some(node => (node as any).id === providerNode))
          nodes.push(json({ id: providerNode, type: "provider", providerHash: request.providerHash }));
        edges.push(json({ from: taskNode, to: providerNode, kind: "REQUESTED_FROM", requests: request.requests }));
      }
      for (const job of task.externalJobs as Record<string, any>[]) {
        const jobNode = `job:${job.jobRef}`;
        nodes.push(json({ id: jobNode, type: "external-job", templateHash: job.templateHash, status: job.status,
          inputHash: job.inputHash, resultHash: job.resultHash, reconciliationHash: job.reconciliationHash }));
        edges.push(json({ from: taskNode, to: jobNode, kind: "USED_EXTERNAL_EFFECT" }));
      }
    }
  }
  const ordered = [...revisions].sort((a, b) => Number(a.revision) - Number(b.revision));
  for (let i = 0; i + 1 < ordered.length; i++)
    edges.push(json({ from: revisionNodeByNumber.get(Number(ordered[i].revision))!,
      to: revisionNodeByNumber.get(Number(ordered[i + 1].revision))!, kind: "NEXT_REVISION" }));
  for (const item of reflections) {
    const runRef = runRefByRaw.get(item.run);
    if (!runRef) continue;
    const reflection: any = item.reflection;
    const reflectionNode = `reflection:${item.hash}`;
    nodes.push(json({ id: reflectionNode, type: "reflection",
      findings: Array.isArray(reflection.findings)
        ? reflection.findings.map((finding: any) => ({ code: finding.code, severity: finding.severity })) : [],
      productivity: reflection.productivity ?? null }));
    edges.push(json({ from: `run:${runRef}`, to: reflectionNode, kind: "REFLECTED_AS" }));
  }
  for (const recovery of recoveryRows) {
    const sourceRef = runRefByRaw.get(String(recovery.run));
    if (!sourceRef) continue;
    const recoveryRef = digest({ objectiveRef, run: sourceRef, revision: Number(recovery.revision) });
    const recoveryNode = `recovery:${recoveryRef}`;
    nodes.push(json({ id: recoveryNode, type: "recovery", revision: Number(recovery.revision),
      state: String(recovery.state), detailHash: digest(String(recovery.detail)) }));
    edges.push(json({ from: `run:${sourceRef}`, to: recoveryNode, kind: "RECOVERED_BY" }));
    const targetRef = recovery.new_run == null ? null : runRefByRaw.get(String(recovery.new_run));
    if (targetRef) edges.push(json({ from: recoveryNode, to: `run:${targetRef}`, kind: "PRODUCED_RUN" }));
  }
  return json({ schema: 1, type: "future-code-rnd-outcome-graph", nodes, edges });
}

export function buildObjectiveEpisode(store: Store, objective: string, integration: Json, gate: Json): BuiltObjectiveEpisode {
  installRndEpisodeTables(store);
  const objectiveRow = store.db.prepare("SELECT goal,cfg,run FROM swarm_objectives WHERE id=?").get(objective);
  invariant(objectiveRow?.run, "unknown or unstarted objective");
  const cfg = store.getMeta<PinnedSwarm>("extension.swarm");
  invariant(cfg && digest(cfg) === objectiveRow.cfg, "objective episode configuration drift");
  const domain = store.getMeta<string>("extension.evidenceDomain") ?? "software-engineering";
  const objectiveRef = digest({ objective });
  const completionBinding = digest({ integration, gate });
  const external = externalEffectSnapshot(store, String(objectiveRow.run), objective);
  invariant(external.unresolved === 0, "cannot capture completed episode with unresolved external effects");
  const externalJobs = external.records as unknown as Record<string, any>[];
  const lineage = store.db.prepare(`SELECT revision,plan,run,reason,created FROM swarm_objective_revisions
    WHERE objective=? ORDER BY revision`).all(objective);
  invariant(lineage.length > 0, "objective episode has no lineage");
  const revisions: Record<string, any>[] = lineage.map(item => {
    store.readArtifact(String(item.plan));
    const run = store.db.prepare("SELECT recipe,contract,started,ended,status FROM runs WHERE id=?").get(item.run);
    invariant(run, "objective lineage references missing run");
    const tasks = store.db.prepare("SELECT id,spec,status,artifact,evidence,error FROM tasks WHERE run=? ORDER BY id")
      .all(item.run).map(row => taskSnapshot(store, cfg, domain, String(item.run), row, externalJobs));
    return {
      revision: Number(item.revision), rawRun: String(item.run),
      runRef: digest({ objectiveRef, revision: Number(item.revision), run: String(item.run) }),
      planHash: String(item.plan), reasonHash: digest(String(item.reason)),
      recipeHash: String(run.recipe), contractHash: String(run.contract), status: String(run.status),
      durationMs: Math.max(0, Number(run.ended ?? run.started) - Number(run.started)),
      tasks, requests: requestGroups(store, String(item.run)), resources: runResourceSummary(store, String(item.run)),
    };
  });
  const recoveryRows = store.db.prepare(`SELECT run,revision,state,detail,new_run,created,updated,reflection_hash,addressed_findings
    FROM swarm_recovery_attempts WHERE objective=? ORDER BY revision,run`).all(objective);
  const reflections = reflectionHistory(store, objective);
  const interventions = interventionHistory(store, objective);
  const stateHashes = revisions.map(revision => digest({
    status: revision.status,
    tasks: (revision.tasks as Record<string, any>[]).map(task => ({
      signature: task.signature, status: task.status, profileHash: task.profileHash,
      strategyHash: task.experience?.strategyHash ?? null,
      failures: (task.attempts as Record<string, any>[]).map(a => a.failureFingerprint).filter(Boolean),
    })),
    resources: revision.resources,
  }));
  const policyTransitions = revisions.map((revision, index) => {
    const next = revisions[index + 1];
    const action = next ? {
      kind: "REPLAN",
      actionHash: digest({ planHash: next.planHash,
        taskSignatures: (next.tasks as Record<string, any>[]).map(task => task.signature).sort() }),
    } : { kind: "COMPLETE", actionHash: digest({ completionBinding }) };
    return json({
      revision: Number(revision.revision), stateHash: stateHashes[index],
      action, nextStateHash: next ? stateHashes[index + 1] : null,
      runOutcome: String(revision.status), resources: revision.resources,
    });
  });
  const graph = buildOutcomeGraph(objectiveRef, domain, revisions, recoveryRows, externalJobs, reflections, completionBinding);
  const graphHash = store.artifact(graph);
  const episode = json({
    schema: 1, type: "future-code-rnd-episode",
    privacy: {
      rawPrompts: false, rawResponses: false, rawGoals: false, rawJobInputs: false, secrets: false,
      note: "Hash-minimized metadata is not a formal anonymization guarantee.",
    },
    objectiveRef, goalHash: digest(String(objectiveRow.goal)), domain,
    configurationHash: String(objectiveRow.cfg), finalRunRef: revisions.at(-1)!.runRef,
    outcome: "PASS", completionBinding,
    revisions: revisions.map(({ rawRun: _rawRun, ...revision }) => json(revision)),
    recoveries: recoveryRows.map(row => json({
      sourceRunRef: revisions.find(r => r.rawRun === String(row.run))?.runRef ?? digest(String(row.run)),
      revision: Number(row.revision), state: String(row.state), detailHash: digest(String(row.detail)),
      reflectionHash: row.reflection_hash == null ? null : String(row.reflection_hash),
      addressedFindings: row.addressed_findings ? JSON.parse(String(row.addressed_findings)) : [],
      targetRunRef: row.new_run == null ? null : revisions.find(r => r.rawRun === String(row.new_run))?.runRef ?? digest(String(row.new_run)),
    })),
    interventions,
    reflections: reflections.map(item => {
      const reflection: any = item.reflection;
      return json({
        runRef: revisions.find(r => r.rawRun === item.run)?.runRef ?? digest(item.run),
        reflectionHash: item.hash,
        findings: Array.isArray(reflection.findings)
          ? reflection.findings.map((finding: any) => ({ code: finding.code, severity: finding.severity })) : [],
        productivity: reflection.productivity ?? null,
      });
    }),
    policyTransitions,
    resources: objectiveResources(store, objective, externalJobs, cfg),
    eventKindCounts: eventKindCounts(store, objective),
    outcomeGraphHash: graphHash,
  });
  const episodeHash = store.artifact(episode);
  return { episodeHash, graphHash };
}

export function persistObjectiveEpisode(store: Store, objective: string, run: string, built: BuiltObjectiveEpisode,
  created = Date.now()): void {
  installRndEpisodeTables(store);
  const current = store.db.prepare("SELECT run,episode_hash,graph_hash,schema FROM rnd_objective_episodes WHERE objective=?").get(objective);
  if (current) {
    invariant(current.run === run && current.episode_hash === built.episodeHash &&
      current.graph_hash === built.graphHash && Number(current.schema) === 1, "objective episode drift");
    return;
  }
  store.db.prepare(`INSERT INTO rnd_objective_episodes(objective,run,episode_hash,graph_hash,schema,created)
    VALUES(?,?,?,?,1,?)`).run(objective, run, built.episodeHash, built.graphHash, created);
}

export function objectiveEpisodeStatus(store: Store, objective: string): Json | null {
  installRndEpisodeTables(store);
  const row = store.db.prepare("SELECT run,episode_hash,graph_hash,schema,created FROM rnd_objective_episodes WHERE objective=?").get(objective);
  return row ? json({ runRef: digest({ objectiveRef: digest({ objective }), run: String(row.run) }),
    episodeHash: String(row.episode_hash), graphHash: String(row.graph_hash),
    schema: Number(row.schema), created: Number(row.created) }) : null;
}

export function readObjectiveEpisode(store: Store, objective: string): Json {
  installRndEpisodeTables(store);
  const row = store.db.prepare("SELECT episode_hash,graph_hash FROM rnd_objective_episodes WHERE objective=?").get(objective);
  invariant(row, "objective episode not captured");
  const episode = store.readArtifact(String(row.episode_hash));
  const graph = store.readArtifact(String(row.graph_hash));
  invariant((episode as any).outcomeGraphHash === row.graph_hash, "objective episode graph binding drift");
  invariant((graph as any).schema === 1 && (graph as any).type === "future-code-rnd-outcome-graph",
    "invalid objective outcome graph");
  return json({ episodeHash: String(row.episode_hash), graphHash: String(row.graph_hash), episode });
}
