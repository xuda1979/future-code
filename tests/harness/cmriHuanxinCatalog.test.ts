/**
 * Tests for the CMRI + Huanxin model catalog: the authoritative model
 * list baked into the future-code binary, default = cmri GLM-5.3.
 */
import { test, expect } from "bun:test";
import {
  MODEL_CATALOG,
  DEFAULT_MODEL_ID,
  PROVIDER_ORDER,
  listModelsByProvider,
  getDefaultModel,
  findModel,
  renderCatalogText,
} from "../../src/utils/model/cmriHuanxinCatalog.ts";

test("catalog contains both cmri and huanxin provider groups", () => {
  const providers = new Set(MODEL_CATALOG.map((m) => m.provider));
  expect(providers.has("cmri")).toBe(true);
  expect(providers.has("huanxin")).toBe(true);
  expect([...providers].sort()).toEqual(["cmri", "huanxin"]);
});

test("exactly one model is marked default and it is cmri GLM-5.3", () => {
  const defaults = MODEL_CATALOG.filter((m) => m.default);
  expect(defaults.length).toBe(1);
  expect(defaults[0].id).toBe("GLM-5.3");
  expect(defaults[0].provider).toBe("cmri");
});

test("DEFAULT_MODEL_ID is cmri GLM-5.3", () => {
  expect(DEFAULT_MODEL_ID).toBe("GLM-5.3");
  expect(findModel(DEFAULT_MODEL_ID)!.provider).toBe("cmri");
});

test("cmri models are the live gateway's model list", () => {
  const cmri = listModelsByProvider("cmri");
  const ids = cmri.map((m) => m.id);
  // Ground truth: the CMRI LiteLLM gateway's (172.23.31.2/token/v1)
  // GET /v1/models response, minus the duplicate openai/zimage alias.
  expect(ids).toEqual([
    "GLM-5.3",
    "GLM-5.2",
    "DeepSeek-v4.1",
    "DeepSeek-V4-Flash-0731",
    "MiniMax-M3",
    "kimi-k3",
    "hy3",
    "hy3-preview",
    "qwen3.8-27b",
    "qwen3-embedding-8b",
    "qwen3-reranker-4b",
    "GLM-OCR",
    "zimage",
  ]);
});

test("huanxin models are listed", () => {
  const huanxin = listModelsByProvider("huanxin");
  const ids = huanxin.map((m) => m.id);
  // Huanxin keeps only dp4 (the deepseek-v4-flash route); the full CMRI
  // catalog (GLM/DeepSeek/Qwen/MiniMax/kimi/hy3/OCR/zimage) lives under
  // provider "cmri".
  expect(ids).toEqual(["dp4"]);
  // All 14 catalog models are accounted for: 13 cmri + 1 huanxin.
  expect(MODEL_CATALOG).toHaveLength(14);
  expect(listModelsByProvider("cmri")).toHaveLength(13);
});

test("findModel is case-insensitive", () => {
  expect(findModel("glm-5.3")!.id).toBe("GLM-5.3");
  expect(findModel("glm-5.2")!.id).toBe("GLM-5.2");
  expect(findModel("deepseek-v4-flash-0731")!.id).toBe("DeepSeek-V4-Flash-0731");
  expect(findModel("Deepseek-V4-Flash-0731")!.id).toBe("DeepSeek-V4-Flash-0731");
  expect(findModel("DP4")!.id).toBe("dp4");
  expect(findModel("no-such-model")).toBeUndefined();
});

test("getDefaultModel falls back to first cmri model when no default flag", () => {
  // Defensive: getDefaultModel must never throw while a cmri entry exists.
  const def = getDefaultModel();
  expect(def.provider).toBe("cmri");
});

test("renderCatalogText lists providers, models, and the default", () => {
  const text = renderCatalogText();
  expect(text).toContain("CMRI");
  expect(text).toContain("HUANXIN");
  expect(text).toContain("GLM-5.3");
  expect(text).toContain("[DEFAULT]");
  expect(text).toContain("Default model: GLM-5.3 (cmri)");
  // Every catalog model id appears in the listing.
  for (const m of MODEL_CATALOG) expect(text).toContain(m.id);
});

test("catalog ids are unique", () => {
  const ids = MODEL_CATALOG.map((m) => m.id.toLowerCase());
  expect(new Set(ids).size).toBe(ids.length);
});

test("PROVIDER_ORDER puts cmri first", () => {
  expect(PROVIDER_ORDER[0]).toBe("cmri");
});
