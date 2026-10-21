"""Strict report readers. A successful tool exit alone cannot pass simulation."""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from plan import fields, integer, read_json, require


def parse(evidence, raw, seed):
    fmt = evidence["format"]
    if fmt == "checks-json":
        data = read_json(raw)
        fields(data, ["schema", "seed", "checks", "bins"])
        require(data["schema"] == 1 and type(data["seed"]) is int and data["seed"] == seed, "report seed mismatch")
        require(isinstance(data["checks"], list), "missing scoreboard checks")
        for row in data["checks"]:
            fields(row, ["id", "passed"])
            require(type(row["passed"]) is bool, "check must have boolean result")
        ids = [r["id"] for r in data["checks"]]
        require(len(ids) == len(set(ids)) and set(ids) == set(evidence["checks"]), "missing or substituted scoreboard check")
        require(isinstance(data["bins"], dict) and all(isinstance(k, str) and integer(v, 0, 2**53 - 1)
                for k, v in data["bins"].items()), "invalid coverage counts")
        failed = [r["id"] for r in data["checks"] if not r["passed"]]
        return {"verdict": "FAIL" if failed else "PASS", "failed": failed, "tests": len(ids), "bins": data["bins"]}
    if fmt == "junit":
        require(not re.search(r"<!\s*(DOCTYPE|ENTITY)", raw, re.I), "XML declarations are forbidden")
        root = ET.fromstring(raw)
        require(root.tag in ("testsuite", "testsuites"), "invalid JUnit root")
        tests = list(root.iter("testcase"))
        require(len(tests) >= evidence["minimumTests"], "empty or incomplete JUnit regression")
        identities = [(x.get("classname", ""), x.get("name")) for x in tests]
        require(all(x[1] for x in identities) and len(set(identities)) == len(identities), "duplicate or unnamed test")
        failed = [x.get("name") for x in tests if x.find("failure") is not None or x.find("error") is not None]
        skipped = [x.get("name") for x in tests if x.find("skipped") is not None]
        for suite in root.iter():
            if suite.tag not in ("testsuite", "testsuites"):
                continue
            children = list(suite.iter("testcase"))
            observed = {"tests": len(children), "failures": sum(x.find("failure") is not None for x in children),
                        "errors": sum(x.find("error") is not None for x in children),
                        "skipped": sum(x.find("skipped") is not None for x in children)}
            for name, actual in observed.items():
                if name in suite.attrib:
                    require(suite.attrib[name].isdigit() and int(suite.attrib[name]) == actual, "inconsistent JUnit totals")
        return {"verdict": "FAIL" if failed else "UNKNOWN" if skipped else "PASS",
                "failed": failed, "skipped": skipped, "tests": len(tests), "bins": {}}
    if fmt == "uvm":
        tests = re.findall(r"\[RNTST\]\s+Running test\s+([A-Za-z_][A-Za-z0-9_:]*)", raw)
        require(tests == [evidence["testName"]], "missing, duplicate or substituted UVM test")
        summaries = list(re.finditer(r"UVM Report Summary", raw))
        require(len(summaries) == 1, "missing or duplicate UVM completion summary")
        summary = raw[summaries[0].end():]
        counts = {}
        for severity in ("ERROR", "FATAL"):
            values = re.findall(rf"^\s*UVM_{severity}\s*:\s*(\d+)\s*$", summary, re.M)
            require(len(values) == 1, "incomplete UVM severity totals")
            counts[severity] = int(values[0])
        events = re.findall(r"^\s*UVM_(?:ERROR|FATAL)\s+(?!:)\S.*$", raw, re.M)
        failed = [name for name, count in counts.items() if count] + events
        return {"verdict": "FAIL" if failed else "PASS", "failed": failed, "tests": None, "bins": {}}
    if fmt == "sby":
        status = raw.strip()
        require(status in ("PASS", "FAIL", "UNKNOWN", "ERROR"), "invalid SBY terminal status")
        return {"verdict": "UNKNOWN" if status in ("UNKNOWN", "ERROR") else status,
                "failed": [] if status == "PASS" else [status], "tests": None, "bins": {},
                "mode": evidence["mode"], "depth": evidence.get("depth"), "assumptions": evidence["assumptions"]}
    require(fmt == "exit-code", "unsupported evidence")
    return {"verdict": "PASS", "failed": [], "tests": None, "bins": {}}
