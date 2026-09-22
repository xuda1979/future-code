import { existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

export type TestRunner = "bun-test" | "node-test" | "pytest" | "unknown";

export interface ProjectCues {
  hasPackageJson: boolean;
  hasBunfig: boolean;
  hasPytestCfg: boolean;
  hasTsConfig: boolean;
  language: "typescript" | "javascript" | "python" | "other";
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

export function detectCues(projectRoot: string): ProjectCues {
  const present = {
    packageJson: existsSync(join(projectRoot, "package.json")),
    bunfig: existsSync(join(projectRoot, "bunfig.toml")),
    tsconfig: existsSync(join(projectRoot, "tsconfig.json")),
    pytestIni: existsSync(join(projectRoot, "pytest.ini")),
    pyproject: existsSync(join(projectRoot, "pyproject.toml")),
    conftest: existsSync(join(projectRoot, "conftest.py")),
    hact: existsSync(join(projectRoot, "src", "hact")),
  };
  const testScript = readTestScript(projectRoot);
  const pyTests = anyPythonTests(projectRoot);
  const pyMarker = present.pytestIni || present.pyproject || present.conftest;

  let language: ProjectCues["language"] = "other";
  let testRunner: TestRunner = "unknown";

  // Prefer Python when it has real .py tests OR explicit python markers,
  // even if a package.json is present without a meaningful JS test script.
  if (pyMarker && (pyTests || !present.packageJson)) {
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
