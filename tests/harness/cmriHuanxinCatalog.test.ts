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

test("cmri models are listed", () => {
  const cmri = listModelsByProvider("cmri");
  const ids = cmri.map((m) => m.id);
  expect(ids).toContain("GLM-5.3");
  expect(ids).toContain("GLM-5.2");
});

test("huanxin models are listed", () => {
  const huanxin = listModelsByProvider("huanxin");
  const ids = huanxin.map((m) => m.id);
  // Per a961b88: Huanxin keeps only dp4 (Huanxin DP4); the full CMRI
  // catalog (GLM/DeepSeek/Qwen/MiniMax/hy3) lives under provider "cmri".
  expect(ids).toEqual(["dp4"]);
  // All 12 catalog models are accounted for: 11 cmri + 1 huanxin.
  expect(MODEL_CATALOG).toHaveLength(12);
  expect(listModelsByProvider("cmri")).toHaveLength(11);
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
