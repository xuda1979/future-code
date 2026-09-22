/**
 * CMRI + Huanxin model catalog — the authoritative list of models the
 * future-code binary can be pointed at, grouped by provider.
 *
 * Grounded in this repo's deployment reality:
 *  - CMRI models are served by the CMRI provider endpoint (the historical
 *    dev.cmri.cn/icoder upstream and its current token-endpoint deployment,
 *    configured via DEEPSEEK_BASE_URL / DEEPSEEK_MODEL_NAME in deepseek.env).
 *  - Huanxin models are served by Huanxin OpenAI-compatible upstreams
 *    (translated by future_huanxin_future_proxy.py, which special-cases
 *    GLM 5.2 streaming/reasoning/window budgeting and the dp4 /
 *    deepseekv4_master ids).
 *
 * The default main-loop model is CMRI GLM-5.3.
 */

/** Provider groups in the catalog. */
export type CatalogProvider = "cmri" | "huanxin";

export interface CatalogModel {
  /** Model id: what you pass to --model / FUTURE_MODEL / DEEPSEEK_MODEL_NAME. */
  id: string;
  /** Provider group: 'cmri' or 'huanxin'. */
  provider: CatalogProvider;
  /** Short human label. */
  label: string;
  /** What the model is + any proxy/upstream notes. */
  description: string;
  /** True for exactly one entry: the default main-loop model. */
  default?: boolean;
  /** Env var the proxy uses to override this model's upstream id, if any. */
  upstreamIdEnv?: string;
  /** Default upstream id the proxy sends for this model, when mapped. */
  upstreamDefaultId?: string;
}

/** Display order of provider groups. */
export const PROVIDER_ORDER: CatalogProvider[] = ["cmri", "huanxin"];

export const PROVIDER_DESCRIPTIONS: Record<CatalogProvider, string> = {
  cmri: "CMRI model platform (dev.cmri.cn/icoder heritage; current deployment: the CMRI provider token endpoint configured in deepseek.env)",
  huanxin: "Huanxin OpenAI-compatible upstreams (translated by future_huanxin_future_proxy.py)",
};

/** The complete model catalog. */
export const MODEL_CATALOG: CatalogModel[] = [
  // ── CMRI models ────────────────────────────────────────────────────────
  {
    id: "GLM-5.3",
    provider: "cmri",
    label: "CMRI GLM-5.3",
    description:
      "Current-generation CMRI GLM model served by the CMRI provider endpoint. " +
      "The default model for the future-code binary.",
    default: true,
  },
  {
    id: "GLM-5.2",
    provider: "cmri",
    label: "CMRI GLM 5.2",
    description:
      "Previous-generation CMRI GLM model. The proxy enables streaming, reasoning " +
      "params, and shared-window budgeting for it; the upstream id is overridable " +
      "via HUANXIN_GLM52_UPSTREAM_MODEL (legacy dev.cmri.cn id: glm-5.2).",
    upstreamIdEnv: "HUANXIN_GLM52_UPSTREAM_MODEL",
    upstreamDefaultId: "glm-5.2",
  },
  // ── Huanxin models ─────────────────────────────────────────────────────
  {
    id: "glm5.2",
    provider: "huanxin",
    label: "Huanxin GLM 5.2",
    description:
      "Huanxin-served GLM 5.2. The proxy special-cases it: forced streaming, " +
      "reasoning params, and ~128K shared context-window budgeting.",
    upstreamIdEnv: "HUANXIN_GLM52_UPSTREAM_MODEL",
    upstreamDefaultId: "glm-5.2",
  },
  {
    id: "dp4",
    provider: "huanxin",
    label: "Huanxin DP4",
    description:
      "DeepSeek-class model behind Huanxin (OpenAI chat API); upstream id " +
      "overridable via HUANXIN_DP4_UPSTREAM_MODEL.",
    upstreamIdEnv: "HUANXIN_DP4_UPSTREAM_MODEL",
  },
  {
    id: "deepseekv4_master",
    provider: "huanxin",
    label: "Huanxin DeepSeek v4 Master",
    description:
      "Huanxin DeepSeek v4 Master subscription tier (may require --appcode).",
  },
  {
    id: "deepseek-v4-flash",
    provider: "huanxin",
    label: "DeepSeek v4 Flash",
    description:
      "DeepSeek v4 Flash — fast tier (former bundle default for small/fast tasks).",
  },
  {
    id: "deepseek-v4-pro",
    provider: "huanxin",
    label: "DeepSeek v4 Pro",
    description:
      "DeepSeek v4 Pro — strong tier; append [1m] for the 1M-context variant " +
      "(e.g. deepseek-v4-pro[1m]).",
  },
];

/** The default main-loop model id: CMRI GLM-5.3. */
export const DEFAULT_MODEL_ID = "GLM-5.3";

/** All models of one provider, in catalog order. */
export function listModelsByProvider(provider: CatalogProvider): CatalogModel[] {
  return MODEL_CATALOG.filter((m) => m.provider === provider);
}

/** The default catalog entry (CMRI GLM-5.3). */
export function getDefaultModel(): CatalogModel {
  const def = MODEL_CATALOG.find((m) => m.default);
  if (def) return def;
  // Defensive fallback: first CMRI entry must exist.
  const cmri = listModelsByProvider("cmri");
  if (cmri.length === 0) throw new Error("model catalog has no cmri models");
  return cmri[0];
}

/** Case-insensitive lookup by model id. */
export function findModel(id: string): CatalogModel | undefined {
  const lower = id.toLowerCase();
  return MODEL_CATALOG.find((m) => m.id.toLowerCase() === lower);
}

/** Human-readable catalog listing, grouped by provider. */
export function renderCatalogText(): string {
  const lines: string[] = [];
  lines.push("future-code model catalog");
  lines.push("");
  for (const provider of PROVIDER_ORDER) {
    const models = listModelsByProvider(provider);
    if (models.length === 0) continue;
    lines.push(`${provider.toUpperCase()} models (provider: ${provider})`);
    lines.push(`  ${PROVIDER_DESCRIPTIONS[provider]}`);
    lines.push("");
    const idWidth = Math.max(...models.map((m) => m.id.length));
    for (const m of models) {
      const id = m.id.padEnd(idWidth);
      const flag = m.default ? "   [DEFAULT]" : "";
      lines.push(`  ${id}   ${m.label}${flag}`);
      lines.push(`${" ".repeat(idWidth + 6)}${m.description}`);
      if (m.upstreamIdEnv) {
        lines.push(
          `${" ".repeat(idWidth + 6)}upstream id env: ${m.upstreamIdEnv}` +
            (m.upstreamDefaultId ? ` (default: ${m.upstreamDefaultId})` : ""),
        );
      }
    }
    lines.push("");
  }
  const def = getDefaultModel();
  lines.push(`Default model: ${def.id} (${def.provider})`);
  lines.push("Usage: future-code --model <id>   (or FUTURE_MODEL / DEEPSEEK_MODEL_NAME)");
  return lines.join("\n");
}
