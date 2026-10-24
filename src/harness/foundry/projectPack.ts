import { builtinDomainPacks, registerDomainPack, validateDomainPack, type DomainPack } from "./evidenceFabric.ts";
import { canonical, digest, invariant } from "./kernel.ts";
import type { Store } from "./store.ts";

/** Operator-owned evidence vocabulary. Executable validators remain pinned separately. */
export type EvidencePackSelection = "software-engineering" | "ml-research" | "scientific-computing" | DomainPack;

export function resolveEvidencePack(selection?: EvidencePackSelection): DomainPack {
  if (selection === undefined || typeof selection === "string") {
    const pack = builtinDomainPacks().find(pack => pack.name === (selection ?? "software-engineering"));
    invariant(pack, "unknown evidence domain pack");
    return pack;
  }
  invariant(selection && typeof selection === "object" && !Array.isArray(selection), "invalid project evidence pack");
  const required = ["schema", "name", "goalKinds", "evidenceKinds", "validators", "adjudicators", "success"];
  invariant(Object.keys(selection).length === required.length && required.every(key => Object.hasOwn(selection, key)),
    "unexpected or missing project evidence pack field");
  invariant(selection.success && typeof selection.success === "object" && !Array.isArray(selection.success) &&
    Object.hasOwn(selection.success, "minimumStrength") && Object.keys(selection.success).every(key =>
      ["minimumStrength", "requireMachineEvidence"].includes(key)), "invalid project evidence pack success policy");
  invariant(Buffer.byteLength(canonical(selection)) <= 65536, "project evidence pack exceeds 64 KiB");
  validateDomainPack(selection);
  return selection;
}

/** Registration stores only declared evidence semantics and grants no capability. */
export function registerProjectPack(store: Store, selection?: EvidencePackSelection): string {
  const pack = resolveEvidencePack(selection);
  if (typeof selection === "object") {
    invariant(!store.getMeta("contract"), "already initialized; contracts cannot be overwritten");
    registerDomainPack(store, pack);
  }
  return pack.name;
}

/** The copied spec is included in worker/verifier identities; registry bytes must match it. */
export function assertProjectPack(store: Store, selection?: EvidencePackSelection): string {
  const pack = resolveEvidencePack(selection);
  if (typeof selection === "object") {
    const row = store.db.prepare("SELECT hash,json FROM fabric_domain_packs WHERE name=?").get(pack.name);
    invariant(row && row.hash === digest(pack) && row.json === canonical(pack), "project evidence pack registry drift");
  }
  return pack.name;
}
