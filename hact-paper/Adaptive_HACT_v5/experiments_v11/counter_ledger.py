"""Stronger service control: an indexed ledger with maintained group counts.

This is a v11 control, not a modification of the historical v9 experiment.
Fixed semantic groups are indexed once, and their PASS/FAIL/UNKNOWN counters
are updated on ingestion. Arbitrary subsets still use the indexed records.
Complete answer schemas, paging and compression are identical across arms.
The groups are selected before observing costs; no tree layout is consulted.
"""
from __future__ import annotations

import time

from experiments_v8 import service_core as core
from experiments_v8.service_baselines import IndexedFlatLedger
from hact.certificates import canonical


class CounterLedger(IndexedFlatLedger):
    def _counter_bytes(self):
        return len(canonical({'group_members': self._group_members,
                              'group_counts': self._group_counts}))

    def _build(self):
        super()._build()
        started = time.perf_counter()
        registry = self.trajectory.registry
        self._group_members = {
            'all': registry,
            'unit': tuple(cid for cid in registry if core.predicate_unit(cid)),
            'integration': tuple(cid for cid in registry if core.predicate_integration(cid)),
        }
        self._member_group = {cid: ('unit' if core.predicate_unit(cid) else 'integration')
                              for cid in registry}
        self._group_counts = {name: {'PASS': 0, 'FAIL': 0, 'UNKNOWN': len(members)}
                              for name, members in self._group_members.items()}
        self._counter_group = {members: name for name, members in self._group_members.items()}
        self.counter_updates = 0
        self.costs.index_build_bytes += self._counter_bytes()
        self.costs.storage_bytes += self._counter_bytes()
        self.costs.index_build_seconds += time.perf_counter() - started

    def _ingest(self, snapshot):
        previous = len(self._ledger)
        super()._ingest(snapshot)
        started = time.perf_counter()
        for event in self._ledger[previous:]:
            status = event['status']
            if status not in core.STATUS_ORDER:
                raise ValueError('invalid canonical status')
            for group in ('all', self._member_group[event['id']]):
                self._group_counts[group]['UNKNOWN'] -= 1
                self._group_counts[group][status] += 1
                self.costs.index_maintenance_bytes += len(canonical({
                    'group': group, 'decrement': 'UNKNOWN', 'increment': status}))
            self.counter_updates += 1
        self.costs.storage_bytes += self._counter_bytes()
        self.costs.index_maintenance_seconds += time.perf_counter() - started

    def _counts(self, selected):
        group = self._counter_group.get(tuple(selected))
        if group is None:
            return super()._counts(selected)
        counts = dict(self._group_counts[group])
        self.costs.aggregation_cpu_calls += 1
        self.costs.aggregation_bytes_scanned += len(canonical(counts))
        return counts
