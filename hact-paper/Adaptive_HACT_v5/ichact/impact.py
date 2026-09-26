"""Intervention-derived advisory priorities. No edge authorizes evidence reuse.

A failed test after an isolated mutation is an observed effect in that frozen
fixture, not a proof of a complete structural causal model or independence.
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Iterable, Mapping, Sequence
import math

@dataclass(frozen=True)
class Intervention:
    source: str
    failures: frozenset[str]
    mutation_id: str

class ImpactModel:
    def __init__(self, registry: Sequence[str], durations: Mapping[str,float],
                 observed_calls: Mapping[str,Iterable[str]], interventions: Sequence[Intervention]):
        self.registry=tuple(registry)
        if not self.registry or len(set(self.registry))!=len(self.registry):
            raise ValueError('nonempty unique registry required')
        self.index={g:i for i,g in enumerate(self.registry)}
        raw={g:float(durations.get(g,0.001)) for g in self.registry}
        if not all(math.isfinite(x) and x>=0 for x in raw.values()):raise ValueError('finite nonnegative costs required')
        self.cost={g:max(0.0001,x) for g,x in raw.items()}
        self.calls={g:frozenset(observed_calls.get(g,())) for g in self.registry}
        if len({x.mutation_id for x in interventions})!=len(interventions):raise ValueError('duplicate intervention')
        if any(not x.failures.issubset(self.index) for x in interventions):raise ValueError('unknown evidence identity')
        self.interventions=tuple(interventions)

    def order(self, source: str, method: str='conditional') -> list[str]:
        if method=='default':return list(self.registry)
        if method=='shortest':return sorted(self.registry,key=lambda g:(self.cost[g],self.index[g]))
        if method=='coverage':
            return sorted(self.registry,key=lambda g:(source not in self.calls[g],self.cost[g],self.index[g]))
        if method not in {'global','conditional'}:raise ValueError('unknown priority method')
        obs=[x for x in self.interventions if x.failures and (method=='global' or x.source==source)]
        if not obs:return self.order(source,'coverage' if method=='conditional' else 'shortest')
        uncovered=list(obs); remaining=set(self.registry); result=[]
        # Greedy empirical fault-set cover per measured cost, an established
        # prioritization primitive. Our compiler optimizes its induced frontiers.
        while uncovered:
            candidate=max(remaining,key=lambda g:(sum(g in x.failures for x in uncovered)/self.cost[g],-self.index[g]))
            if not any(candidate in x.failures for x in uncovered):break
            result.append(candidate);remaining.remove(candidate)
            uncovered=[x for x in uncovered if candidate not in x.failures]
        tail=self.order(source,'coverage' if method=='conditional' else 'shortest')
        result.extend(g for g in tail if g in remaining)
        assert len(result)==len(self.registry) and set(result)==set(self.registry)
        return result
