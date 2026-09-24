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
  // ── CMRI models (all served by the CMRI gateway endpoint) ──────────────
  {
    id: "GLM-5.3",
    provider: "cmri",
    label: "CMRI GLM-5.3",
    description:
      "CMRI model — current-generation GLM served by the CMRI provider endpoint. " +
      "The default main-loop model for future-code.",
    default: true,
  },
  {
    id: "GLM-5.2",
    provider: "cmri",
    label: "CMRI GLM-5.2",
    description:
      "CMRI model — previous-generation GLM with streaming, reasoning params, " +
      "and 128K context-window budgeting.",
  },
  {
    id: "GLM-4.7",
    provider: "cmri",
    label: "CMRI GLM-4.7",
    description:
      "CMRI model — GLM 4.7 generation, served by the CMRI gateway.",
  },
  {
    id: "DeepSeek-V4",
    provider: "cmri",
    label: "CMRI DeepSeek-V4",
    description:
      "CMRI model — DeepSeek V4 served through the CMRI gateway. Strong reasoning tier.",
  },
  {
    id: "DeepSeek-V4-Flash-0731",
    provider: "cmri",
    label: "CMRI DeepSeek-V4-Flash",
    description:
      "CMRI model — DeepSeek V4 Flash (0731 build), fast tier for lower-latency tasks.",
  },
  {
    id: "Qwen3.5-397B",
    provider: "cmri",
    label: "CMRI Qwen3.5-397B",
    description:
      "CMRI model — Qwen 3.5 (397B parameters) served by the CMRI gateway.",
  },
  {
    id: "qwen3.6-27b",
    provider: "cmri",
    label: "CMRI Qwen3.6-27B",
    description:
      "CMRI model — Qwen 3.6 (27B parameters) served by the CMRI gateway.",
  },
  {
    id: "MiniMax-M2.7",
    provider: "cmri",
    label: "CMRI MiniMax-M2.7",
    description:
      "CMRI model — MiniMax M2.7 served by the CMRI gateway.",
  },
  {
    id: "hy3",
    provider: "cmri",
    label: "CMRI hy3",
    description:
      "CMRI model — hy3 served by the CMRI gateway.",
  },
  {
    id: "DeepSeek-V4-Flash-0731-dev",
    provider: "cmri",
    label: "CMRI DeepSeek-V4-Flash (dev)",
    description:
      "CMRI model — DeepSeek V4 Flash dev build, for testing upstream changes.",
  },
  {
    id: "GLM-5.2-dev",
    provider: "cmri",
    label: "CMRI GLM-5.2 (dev)",
    description:
      "CMRI model — GLM-5.2 dev build, for testing upstream changes.",
  },
  // ── Huanxin models ─────────────────────────────────────────────────────
  {
    id: "dp4",
    provider: "huanxin",
    label: "Huanxin DP4",
    description:
      "Huanxin model — DeepSeek-class model behind Huanxin (OpenAI chat API); " +
      "upstream id overridable via HUANXIN_DP4_UPSTREAM_MODEL.",
    upstreamIdEnv: "HUANXIN_DP4_UPSTREAM_MODEL",
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
