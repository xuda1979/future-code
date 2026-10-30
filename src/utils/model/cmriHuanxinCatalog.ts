/**
 * CMRI + Huanxin model catalog — the authoritative list of models the
 * future-code binary can be pointed at, grouped by provider.
 *
 * Grounded in this repo's deployment reality (verified against the live
 * CMRI gateway's GET /v1/models response):
 *  - CMRI models are served by the CMRI LiteLLM gateway
 *    (172.23.31.2/token/v1), which lists exactly these model ids:
 *    DeepSeek-V4-Flash-0731, DeepSeek-v4.1, GLM-5.2, GLM-5.3, GLM-OCR,
 *    MiniMax-M3, hy3, hy3-preview, kimi-k3, openai/zimage, qwen3-embedding-8b,
 *    qwen3-reranker-4b, qwen3.8-27b, zimage.
 *  - The Huanxin dp4 entry is the Huanxin OpenAI-compatible upstream
 *    (deepseek-v4-flash route), translated by future_huanxin_future_proxy.py.
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
  cmri: "CMRI LiteLLM gateway (172.23.31.2/token/v1; the dev.cmri.cn/icoder heritage)",
  huanxin: "Huanxin OpenAI-compatible upstreams (translated by future_huanxin_future_proxy.py)",
};

/**
 * The complete model catalog. CMRI ids are the live gateway's model ids
 * verbatim (case matters: "DeepSeek-v4.1" vs "DeepSeek-V4-Flash-0731").
 * Descriptions are the CMRI model-platform descriptions (中文) for the
 * gateway's models, as provided by the deployment owner.
 */
export const MODEL_CATALOG: CatalogModel[] = [
  // ── CMRI models (live gateway: 172.23.31.2/token/v1) ────────────────────
  {
    id: "GLM-5.3",
    provider: "cmri",
    label: "GLM-5.3",
    description:
      "智谱AI（Z.ai），2026年8月14日发布。能力：复杂软件工程、长时程Agent、涌现网络安全能力。" +
      "特点：与GLM-5.2同基座，纯靠长程Agent强化学习提升。参数：MoE总约744B/激活40B，1M上下文。",
    default: true,
  },
  {
    id: "GLM-5.2",
    provider: "cmri",
    label: "GLM-5.2",
    description:
      "智谱AI（Z.ai），2026年6月13日发布。能力：长时程工程编程、项目级开发。特点：IndexShare索引共享。" +
      "参数：MoE总744B/激活40B，1M上下文。",
  },
  {
    id: "DeepSeek-v4.1",
    provider: "cmri",
    label: "DeepSeek-v4.1",
    description:
      "DeepSeek（深度求索），2026年9月10日发布。能力：长时程Agent、Agentic Coding、原生视觉理解。" +
      "特点：Causal Encoder-Decoder非对称激活、CSA2跨层KV复用+FP4压缩至890字节/token。" +
      "参数：MoE总552B（+196B Engram），1M上下文，384K最大输出。",
  },
  {
    id: "DeepSeek-V4-Flash-0731",
    provider: "cmri",
    label: "DeepSeek-V4-Flash-0731",
    description:
      "DeepSeek（深度求索），2026年7月31日发布。能力：Agent与编程工具调用。" +
      "特点：仅重后训练即大幅提升、CSA+HCA混合注意力。参数：MoE总284B/激活13B，1M上下文。",
  },
  {
    id: "MiniMax-M3",
    provider: "cmri",
    label: "MiniMax-M3",
    description:
      "MiniMax（稀宇科技），2026年6月1日发布。能力：前沿编程与Agent、原生多模态（图文/视频/桌面操作）。" +
      "特点：自研MSA稀疏注意力。参数：MoE总428B/激活23B，1M上下文。",
  },
  {
    id: "kimi-k3",
    provider: "cmri",
    label: "kimi-k3",
    description:
      "月之暗面（Moonshot AI），2026年7月16日发布。能力：长程编程、前端代码、Agent、复杂推理。" +
      "特点：KDA混合线性注意力+MLA交错架构、原生视觉。参数：MoE 2.8T/激活104B，1M上下文。",
  },
  {
    id: "hy3",
    provider: "cmri",
    label: "hy3",
    description:
      "腾讯混元，2026年7月6日发布。能力：Agent、编程、办公。特点：快慢思考融合MoE、主打实用性价比。" +
      "参数：MoE总295B/激活21B，256K上下文。",
  },
  {
    id: "hy3-preview",
    provider: "cmri",
    label: "hy3-preview",
    description:
      "腾讯混元，2026年4月23日发布并开源。能力：复杂推理、指令遵循/上下文学习、编程、Agent。" +
      "特点：快慢思考融合MoE、预训练与强化学习基础设施重构后首个模型、主打实用性价比。" +
      "参数：MoE总295B/激活21B，256K上下文。",
  },
  {
    id: "qwen3.8-27b",
    provider: "cmri",
    label: "qwen3.8-27b",
    description:
      "阿里千问，2026年8月14日发布。能力：原生多模态（图/视频）、编程、Computer Use。" +
      "特点：稠密Dense架构、原生多模态。参数：Dense 27B，262K上下文。",
  },
  {
    id: "qwen3-embedding-8b",
    provider: "cmri",
    label: "qwen3-embedding-8b",
    description:
      "阿里千问，2025年6月5日发布。定位：文本表征（Embedding）模型。能力：文本检索、代码检索、文本分类、" +
      "聚类、双语挖掘。特点：基于Qwen3-8B稠密基座、双塔结构、指令感知、MRL支持自定义向量维度、" +
      "覆盖100+语言，三阶段训练。参数：8B，32K上下文。",
  },
  {
    id: "qwen3-reranker-4b",
    provider: "cmri",
    label: "qwen3-reranker-4b",
    description:
      "阿里千问，2025年6月5日发布。定位：文本重排序（Reranker）模型。能力：查询-文档相关性精排，" +
      "面向搜索与RAG场景。特点：基于Qwen3-4B-Base、单塔交叉结构、指令感知、100+语言，两阶段训练。" +
      "参数：4B，32K上下文。",
  },
  {
    id: "GLM-OCR",
    provider: "cmri",
    label: "GLM-OCR",
    description:
      "GLM-OCR 是一款轻量级的专业 OCR 模型，参数仅为0.9B。支持照片、截图、扫描件、文档输入，" +
      "能够识别手写体、印章、代码等特殊文字，可广泛应用于教育、科研、办公等场景。",
  },
  {
    id: "zimage",
    provider: "cmri",
    label: "zimage",
    description:
      "内部部署模型，经统一网关鉴权后按需调用，兼容 OpenAI 接口。",
  },
  // ── Huanxin models ─────────────────────────────────────────────────────
  {
    id: "dp4",
    provider: "huanxin",
    label: "Huanxin DP4 (DeepSeek-V4-Flash)",
    description:
      "DeepSeek-V4-Flash route behind the Huanxin OpenAI-compatible upstream; " +
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

/** The default catalog model (CMRI GLM-5.3). */
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
