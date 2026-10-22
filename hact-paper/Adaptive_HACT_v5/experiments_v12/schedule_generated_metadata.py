"""Separate, pre-frozen ExceptionGroup generated-module provenance repair."""
from __future__ import annotations

import argparse
import copy
from pathlib import Path

from experiments_v12 import schedule_study as parent

OUTPUT = parent.ROOT / 'results/v12/schedule_generated_metadata'


def freeze(upstreams):
    target = OUTPUT / 'FROZEN_MANIFEST.json'
    if target.exists():
        raise FileExistsError('never overwrite a frozen child campaign')
    initial = parent.read(parent.ROOT / 'results/v12/schedule_shift/FROZEN_MANIFEST.json')
    frozen = copy.deepcopy(initial)
    entry = next(e for e in frozen['projects'] if e['project'] == 'exceptiongroup')
    parent.verify_sources(entry, upstreams / 'exceptiongroup')
    generated = 'src/exceptiongroup/_version.py'
    path = upstreams / 'exceptiongroup' / generated
    raw = path.read_bytes()
    digest = parent.sha(raw)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / 'generated_version.py').write_bytes(raw)
    entry['generated_runtime_files'] = {generated: digest}
    entry['source_file_sha256'][generated] = digest
    entry['tracked_source_manifest_sha256'] = entry['source_manifest_sha256']
    entry['source_manifest_sha256'] = parent.sha(parent.canonical(entry['source_file_sha256']))
    frozen.update(schema='hact-v12-schedule-generated-metadata-1',
                  frozen_at=parent.stamp(), projects=[entry],
                  parent_manifest_sha256=parent.sha((parent.ROOT / 'results/v12/schedule_shift/FROZEN_MANIFEST.json').read_bytes()),
                  expected_runs=6, environment=parent.environment())
    for name in ('docs/V12_GENERATED_METADATA_REPAIR.md',
                 'experiments_v12/schedule_generated_metadata.py',
                 'results/v12/schedule_generated_metadata/generated_version.py'):
        frozen['files_sha256'][name] = parent.sha((parent.ROOT / name).read_bytes())
    # Reject changes to every inherited protocol, layout and producer dependency.
    for name, expected in frozen['files_sha256'].items():
        if parent.sha((parent.ROOT / name).read_bytes()) != expected:
            raise ValueError('frozen parent input changed: ' + name)
    parent.verify_sources(entry, upstreams / 'exceptiongroup')
    parent.write_json(target, frozen)
    return frozen


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--upstreams', type=Path, required=True)
    args = parser.parse_args()
    parent.PROJECTS = ('exceptiongroup',)
    parent.OUT = OUTPUT
    parent.freeze = freeze
    parent.collect(args.upstreams.resolve())
    summary = parent.read(OUTPUT / 'SUMMARY.json')
    summary['complete'] = len(summary['runs']) == 6
    summary['expected_runs'] = 6
    summary['scope'] = 'all predeclared ExceptionGroup schedules; separate generated-metadata provenance repair'
    parent.write_json(OUTPUT / 'SUMMARY.json', summary)


if __name__ == '__main__':
    main()
