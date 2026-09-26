"""Read-only pytest evidence recorder and complete-registry ordering hook.
No test is deselected. Profiling dependencies are advisory, never permission to skip.
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import pytest

STATE = {'schema': 1, 'registry': [], 'executed': [], 'records': {}, 'collection_errors': []}
START = time.perf_counter()
ROOT = Path(os.environ.get('IC_SOURCE_ROOT', '.')).resolve()
PROFILE = os.environ.get('IC_PROFILE') == '1'

def pytest_collection_modifyitems(session, config, items):
    ids = [x.nodeid for x in items]
    if len(set(ids)) != len(ids):
        raise pytest.UsageError('duplicate evidence identity')
    STATE['registry'] = ids
    path = os.environ.get('IC_ORDER')
    if path:
        order = json.loads(Path(path).read_text())
        if len(order) != len(ids) or set(order) != set(ids):
            raise pytest.UsageError('order must be an exact permutation, never a test selection')
        rank = {name: i for i, name in enumerate(order)}
        items.sort(key=lambda x: rank[x.nodeid])
    STATE['scheduled'] = [x.nodeid for x in items]

@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_protocol(item, nextitem):
    start = time.perf_counter()
    STATE['executed'].append(item.nodeid)
    rec = {'phases': {}, 'dependencies': [], 'wall_seconds': None}
    STATE['records'][item.nodeid] = rec
    deps = set(); cache = {}
    def tracer(frame, event, arg):
        if event != 'call': return
        filename = frame.f_code.co_filename
        if filename not in cache:
            try:
                rel = Path(filename).resolve().relative_to(ROOT).as_posix()
                cache[filename] = rel if '/tests/' not in ('/' + rel) and not rel.startswith('tests/') else None
            except (ValueError, OSError): cache[filename] = None
        if cache[filename]: deps.add(cache[filename])
    old = sys.getprofile()
    if PROFILE: sys.setprofile(tracer)
    try: yield
    finally:
        if PROFILE: sys.setprofile(old)
        rec['dependencies'] = sorted(deps)
        rec['wall_seconds'] = time.perf_counter() - start

def pytest_runtest_logreport(report):
    rec = STATE['records'].setdefault(report.nodeid, {'phases': {}, 'dependencies': []})
    rec['phases'][report.when] = {'outcome': report.outcome, 'seconds': report.duration}
    if report.failed: rec['failure'] = str(report.longrepr)[:12000]

def pytest_collectreport(report):
    if report.failed: STATE['collection_errors'].append(str(report.longrepr)[:12000])

def pytest_sessionfinish(session, exitstatus):
    STATE['exitstatus'] = int(exitstatus)
    STATE['pytest_wall_seconds'] = time.perf_counter() - START
    STATE['profiled'] = PROFILE; STATE['python'] = sys.version
    STATE['package_origins'] = {n: getattr(sys.modules.get(n), '__file__', None)
                                for n in ['networkx', 'toolz', 'future_code']}
    STATE['source_sha256'] = {}
    for rel in sorted({x for r in STATE['records'].values() for x in r['dependencies']}):
        p = ROOT / rel
        if p.is_file(): STATE['source_sha256'][rel] = hashlib.sha256(p.read_bytes()).hexdigest()
    for rec in STATE['records'].values():
        phases = rec['phases']
        if any(v['outcome'] == 'failed' for v in phases.values()): rec['status'] = 'FAIL'
        elif set(phases) == {'setup', 'call', 'teardown'} and all(v['outcome'] == 'passed' for v in phases.values()): rec['status'] = 'PASS'
        else: rec['status'] = 'UNKNOWN'
    output = os.environ.get('IC_REPORT')
    if output:
        p = Path(output); p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix('.tmp'); tmp.write_text(json.dumps(STATE, sort_keys=True, indent=2)); os.replace(tmp,p)
