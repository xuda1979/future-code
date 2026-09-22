/**
 * Harness registry — find, load, validate, and persist harness manifests
 * for a target project. The manifest lives under <project>/.future-code/.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { HarnessManifest, ImprovementProposal } from "./types.ts";

export const HARNESS_DIR = ".future-code";
export const MANIFEST_NAME = "harness.json";
export const SCHEMA = 1;

/** Absolute path to the harness directory for a project. */
export function harnessDir(projectRoot: string): string {
  return join(projectRoot, HARNESS_DIR, "harness");
}

/** Absolute path to the manifest file. */
export function manifestPath(projectRoot: string): string {
  return join(harnessDir(projectRoot), MANIFEST_NAME);
}

export function hasManifest(projectRoot: string): boolean {
  return existsSync(manifestPath(projectRoot));
}

function assertManifest(m: HarnessManifest): void {
  if (!m || m.schema !== SCHEMA) throw new Error(`unsupported manifest schema ${m?.schema}`);
  if (!m.harnessId || !m.project) throw new Error("manifest missing harnessId/project");
  if (!Array.isArray(m.tools) || !Array.isArray(m.gates) || !Array.isArray(m.slos)) {
    throw new Error("manifest missing tools/gates/slos arrays");
  }
}

/** Load + validate a manifest; throws if absent/invalid. */
export function loadManifest(projectRoot: string): HarnessManifest {
  const p = manifestPath(projectRoot);
  if (!existsSync(p)) throw new Error(`no harness manifest at ${p}; run 'future-code harness build'`);
  const m = JSON.parse(readFileSync(p, "utf8")) as HarnessManifest;
  assertManifest(m);
  return m;
}

/** Save + validate a manifest. */
export function saveManifest(projectRoot: string, m: HarnessManifest): void {
  assertManifest(m);
  m.updatedAt = new Date().toISOString();
  const dir = harnessDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(manifestPath(projectRoot), JSON.stringify(m, null, 2) + "\n", "utf8");
}

/** Append an improvement proposal to a manifest's history and persist. */
export function recordImprovement(projectRoot: string, proposal: ImprovementProposal): HarnessManifest {
  const m = loadManifest(projectRoot);
  m.improvementHistory = m.improvementHistory ?? [];
  m.improvementHistory.push(proposal);
  saveManifest(projectRoot, m);
  return m;
}

export type { HarnessManifest, ImprovementProposal };
