import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";

export type TestRunner =
  | "bun-test"
  | "node-test"
  | "pytest"
  | "go-test"
  | "cargo-test"
  | "unknown";

export interface ProjectCues {
  hasPackageJson: boolean;
  hasBunfig: boolean;
  hasPytestCfg: boolean;
  hasTsConfig: boolean;
  hasGoMod: boolean;
  hasCargoToml: boolean;
  /** True when typescript is resolvable locally (node_modules or declared dep). */
  hasLocalTypescript: boolean;
  language: "typescript" | "javascript" | "python" | "golang" | "rust" | "other";
  testRunner: TestRunner;
  hasHactPkg: boolean;
  hasPythonTests: boolean;
  testScript?: string;
  name: string;
}

function readTestScript(projectRoot: string): string {
  const p = join(projectRoot, "package.json");
  if (!existsSync(p)) return "";
  try {
    const d = JSON.parse(require("node:fs").readFileSync(p, "utf8"));
    const s = (d.scripts || {}).test;
    return typeof s === "string" ? s : "";
  } catch {
    return "";
  }
}

function anyPythonTests(projectRoot: string): boolean {
  for (const dir of ["tests", "test"]) {
    const d = join(projectRoot, dir);
    if (!existsSync(d)) continue;
    try {
      const hits = readdirSync(d).filter((f) => f.endsWith(".py"));
      if (hits.length) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

/**
 * True when TypeScript is resolvable locally: either installed in
 * node_modules or declared as a dependency. Guards the typecheck gate —
 * we never scaffold a gate whose command would hang fetching packages.
 */
function hasLocalTypescript(projectRoot: string): boolean {
  if (existsSync(join(projectRoot, "node_modules", "typescript", "bin", "tsc"))) return true;
  if (existsSync(join(projectRoot, "node_modules", ".bin", "tsc"))) return true;
  const pkgPath = join(projectRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const deps = { ...pkg.devDependencies, ...pkg.dependencies };
      if (deps && typeof deps.typescript === "string") return true;
    } catch {
      /* ignore malformed package.json */
    }
  }
  return false;
}

export function detectCues(projectRoot: string): ProjectCues {
  const present = {
    packageJson: existsSync(join(projectRoot, "package.json")),
    bunfig: existsSync(join(projectRoot, "bunfig.toml")),
    tsconfig: existsSync(join(projectRoot, "tsconfig.json")),
    pytestIni: existsSync(join(projectRoot, "pytest.ini")),
    pyproject: existsSync(join(projectRoot, "pyproject.toml")),
    conftest: existsSync(join(projectRoot, "conftest.py")),
    hact: existsSync(join(projectRoot, "src", "hact")),
    goMod: existsSync(join(projectRoot, "go.mod")),
    cargoToml: existsSync(join(projectRoot, "Cargo.toml")),
  };
  const testScript = readTestScript(projectRoot);
  const pyTests = anyPythonTests(projectRoot);
  const pyMarker = present.pytestIni || present.pyproject || present.conftest;

  let language: ProjectCues["language"] = "other";
  let testRunner: TestRunner = "unknown";

  // Go/Rust module markers are unambiguous: they take priority when present.
  if (present.goMod) {
    language = "golang";
    testRunner = "go-test";
  } else if (present.cargoToml) {
    language = "rust";
    testRunner = "cargo-test";
  } else if (pyMarker && (pyTests || !present.packageJson)) {
    // Prefer Python when it has real .py tests OR explicit python markers,
    // even if a package.json is present without a meaningful JS test script.
    language = "python";
    testRunner = "pytest";
  } else if (pyTests && (!present.packageJson || !testScript)) {
    language = "python";
    testRunner = "pytest";
  } else if (present.packageJson) {
    language = present.tsconfig ? "typescript" : "javascript";
    if (present.bunfig || /bun test/.test(testScript)) testRunner = "bun-test";
    else testRunner = "node-test";
  } else if (pyMarker) {
    language = "python";
    testRunner = "pytest";
  }

  return {
    hasPackageJson: present.packageJson,
    hasBunfig: present.bunfig,
    hasPytestCfg: present.pytestIni || present.pyproject,
    hasTsConfig: present.tsconfig,
    hasGoMod: present.goMod,
    hasCargoToml: present.cargoToml,
    hasLocalTypescript: hasLocalTypescript(projectRoot),
    language,
    testRunner,
    hasHactPkg: present.hact,
    hasPythonTests: pyTests,
    testScript: testScript || undefined,
    name: basename(projectRoot),
  };
}

export function describeCues(c: ProjectCues): string {
  return `language=${c.language} testRunner=${c.testRunner} name=${c.name}`;
}
