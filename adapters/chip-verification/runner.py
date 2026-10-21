"""Bounded local regressions, fresh seed directories, and immutable evidence."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import hashlib
import os
from pathlib import Path
import selectors
import signal
import stat
import subprocess
import tempfile
import time

from evidence import parse
from plan import canonical, confined, digest, evidence_kind, require, validate, validate_formal_configs


def file_identity(path, limit=None):
    # O_NONBLOCK prevents a malicious FIFO from hanging evidence collection.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        before = os.fstat(source.fileno())
        require(stat.S_ISREG(before.st_mode), "evidence must be a regular file")
        require(limit is None or before.st_size <= limit, "artifact exceeds budget")
        checksum, size = hashlib.sha256(), 0
        while chunk := source.read(65536):
            size += len(chunk)
            require(limit is None or size <= limit, "artifact exceeds budget")
            checksum.update(chunk)
        after = os.fstat(source.fileno())
        require((before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                == (after.st_size, after.st_mtime_ns, after.st_ctime_ns) and size == after.st_size,
                "input or evidence changed while hashing")
        return {"sha256": checksum.hexdigest(), "bytes": size}


def _kill_tree(child):
    # Inherit the host's process group: killing a Foundry check also kills tools.
    # Per-step deadlines kill descendants first without killing sibling seeds.
    try:
        if Path("/proc/self/stat").exists():
            parents = []
            for entry in Path("/proc").iterdir():
                if not entry.name.isdigit():
                    continue
                try:
                    parts = (entry / "stat").read_text().rsplit(") ", 1)[1].split()
                    parents.append((int(entry.name), int(parts[1])))
                except (OSError, IndexError, ValueError):
                    pass
        else:
            rows = subprocess.check_output(["/bin/ps", "-eo", "pid=,ppid="], text=True, timeout=2, stderr=subprocess.DEVNULL)
            parents = [tuple(map(int, row.split())) for row in rows.splitlines()]
        owned = {child.pid}
        for _ in range(len(parents) + 1):
            more = {pid for pid, parent in parents if parent in owned}
            if more <= owned:
                break
            owned.update(more)
        for pid in sorted(owned - {child.pid}, reverse=True):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    try:
        child.kill()
    except ProcessLookupError:
        pass
    child.wait(timeout=5)


def _execute(argv, cwd, env, timeout, limit, log):
    started = time.monotonic()
    reason, size = None, 0
    child = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    try:
        with open(log, "xb") as output:
            while selector.get_map():
                if time.monotonic() - started >= timeout:
                    reason = "TIMEOUT"
                    break
                for key, _ in selector.select(min(0.05, timeout)):
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    remaining = max(0, limit - size)
                    output.write(chunk[:remaining])
                    size += len(chunk)
                    if size > limit:
                        reason = "OUTPUT_LIMIT"
                        break
                if reason:
                    break
        if reason:
            _kill_tree(child)
        else:
            try:
                child.wait(timeout=max(0.001, timeout - (time.monotonic() - started)))
            except subprocess.TimeoutExpired:
                reason = "TIMEOUT"
                _kill_tree(child)
        return {"code": child.returncode, "reason": reason, "elapsedMs": round((time.monotonic() - started) * 1000),
                "log": log.name, "truncated": size > limit}
    finally:
        if child.poll() is None:
            _kill_tree(child)
        selector.close()
        child.stdout.close()


def run_plan(plan, project, output=None):
    validate(plan)
    require(os.name == "posix", "local chip verification requires POSIX (Linux/macOS/WSL)")
    project = Path(project).resolve()
    validate_formal_configs(plan, project)
    if output is not None:
        Path(output).mkdir(parents=True, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix="chip-verification-", dir=output)).resolve()
    inputs = {name: file_identity(confined(project, name)) for name in plan["inputs"]}
    implementation = {name: file_identity(Path(__file__).parent / name)
                      for name in ("verify.py", "runner.py", "plan.py", "evidence.py")}
    tools = {step["argv"][0]: file_identity(Path(step["argv"][0]).resolve())
             for case in plan["cases"] for step in case["steps"]}
    deadline = time.monotonic() + plan["timeoutMs"] / 1000

    def run(case, seed):
        work = directory / f"{case['id']}-{seed}"
        work.mkdir()
        row = {"case": case["id"], "seed": seed, "kind": evidence_kind(case["evidence"]),
               "verdict": "UNKNOWN", "steps": [], "artifacts": {}, "bins": {}, "directory": str(work)}
        env = {"PATH": os.environ.get("PATH", ""), "HOME": str(work), "TMPDIR": str(work),
               "LANG": "C.UTF-8", "FUTURE_VERIFY_SEED": str(seed)}
        env.update({name: os.environ[name] for name in plan.get("envAllow", []) if name in os.environ})
        try:
            remaining_output = plan["maxOutputBytes"]
            for i, step in enumerate(case["steps"]):
                left = deadline - time.monotonic()
                require(left > 0, "plan deadline exceeded")
                argv = [a.replace("{project}", str(project)).replace("{work}", str(work)).replace("{seed}", str(seed))
                        for a in step["argv"]]
                result = _execute(argv, work, env, min(left, step["timeoutMs"] / 1000), remaining_output, work / f"step-{i}.log")
                row["steps"].append(result)
                meta = file_identity(work / result["log"], plan["maxOutputBytes"])
                row["artifacts"][result["log"]] = meta
                remaining_output -= meta["bytes"]
                if result["reason"]:
                    row["error"] = result["reason"]
                    row["diagnostic"] = (work / result["log"]).read_text(errors="replace")[-2048:]
                    return row
                if result["code"] != 0:
                    row.update(verdict="FAIL", error="TOOL_EXIT")
                    row["diagnostic"] = (work / result["log"]).read_text(errors="replace")[-2048:]
                    return row
            evidence = case["evidence"]
            raw = ""
            if evidence["format"] != "exit-code":
                path = confined(work, evidence["path"])
                row["artifacts"][evidence["path"]] = file_identity(path, plan["maxArtifactBytes"])
                raw = path.read_text()
                require(file_identity(path, plan["maxArtifactBytes"]) == row["artifacts"][evidence["path"]], "evidence changed while reading")
            row.update(parse(evidence, raw, seed))
            for name in case.get("artifacts", []):
                row["artifacts"][name] = file_identity(confined(work, name), plan["maxArtifactBytes"])
            require(sum(meta["bytes"] for meta in row["artifacts"].values())
                    <= plan["maxArtifactBytes"] + plan["maxOutputBytes"], "combined artifacts exceed budget")
        except Exception as error:
            row.update(verdict="UNKNOWN", error=f"{type(error).__name__}: {error}")
            if row["steps"]:
                row["diagnostic"] = (work / row["steps"][-1]["log"]).read_text(errors="replace")[-2048:]
        return row

    matrix = [(case, seed) for case in plan["cases"] for seed in case["seeds"]]
    with ThreadPoolExecutor(max_workers=plan["maxParallel"]) as pool:
        futures = [pool.submit(run, case, seed) for case, seed in matrix]
        runs = [future.result() for future in futures]
    goals = []
    for goal in plan["coverage"]:
        selected = [r for r in runs if r["case"] == goal["case"]]
        complete = all(r["verdict"] == "PASS" and set(goal["bins"]) <= r["bins"].keys() for r in selected)
        bins = {name: sum(r["bins"].get(name, 0) for r in selected) for name in goal["bins"]}
        holes = [name for name, count in bins.items() if count == 0]
        fraction = (len(bins) - len(holes)) / len(bins) if complete else None
        goals.append({"id": goal["id"], "verdict": "UNKNOWN" if not complete else "PASS" if fraction >= goal["minimum"] else "FAIL",
                      "fraction": fraction, "minimum": goal["minimum"], "bins": bins, "uncoveredBins": holes})
    requirements = [{"id": req["id"], "evidence": req["evidence"],
                     "verdict": _verdict([r["verdict"] for r in runs if r["case"] in req["cases"]])}
                    for req in plan["requirements"]]
    changed = False
    try:
        changed = inputs != {name: file_identity(confined(project, name)) for name in inputs}
        changed |= tools != {name: file_identity(Path(name).resolve()) for name in tools}
        changed |= implementation != {name: file_identity(Path(__file__).parent / name) for name in implementation}
    except (OSError, ValueError):
        changed = True
    verdict = "UNKNOWN" if changed else _verdict([r["verdict"] for r in runs + goals + requirements])
    report = {"schema": 1, "name": plan["name"], "planHash": digest(plan), "inputs": inputs, "tools": tools,
              "implementation": implementation,
              "verdict": verdict, "inputsChanged": changed, "runs": runs, "coverage": goals, "requirements": requirements,
              "evidenceDirectory": str(directory), "scope": "Declared RTL/tool contract only; no whole-chip or physical signoff claim"}
    (directory / "plan.json").write_bytes(canonical(plan))
    (directory / "report.json").write_bytes(canonical(report))
    return report


def _verdict(values):
    return "FAIL" if "FAIL" in values else "UNKNOWN" if not values or "UNKNOWN" in values else "PASS"
