"""Stable-ID evidence and fail-closed, generation-fenced layout migration.

Semantic registry IDs never change when the display order does. A layout switch
rebuilds the local kernel from trusted canonical records; ordinal cache entries
and publication tickets are never transplanted to a different permutation.
"""
from __future__ import annotations
from dataclasses import dataclass
import threading
from hact.certificates import Kernel, Gate, Evidence, Ticket, digest
from .layout import Layout


@dataclass(frozen=True)
class StableToken:
    epoch: int
    gate_id: str
    binding: str


@dataclass(frozen=True)
class LayoutTicket:
    epoch: int
    generation: int
    registry: str
    layout: str
    ticket: Ticket


class AdaptiveGuard:
    def __init__(self, registry, snapshot: str, checker: str, environment: str, layout: Layout):
        self.registry=tuple(registry)
        if layout.registry!=self.registry:raise ValueError('layout semantic registry mismatch')
        if any(not isinstance(x,str) or not x for x in (snapshot,checker,environment)):raise ValueError('explicit identities required')
        self.semantic_hash=digest(self.registry)
        self.snapshot=snapshot;self.checker=checker;self.environment=environment
        self.epoch=0;self.generation=0;self.layout=layout
        self.records={};self.conflicted=set();self._issued=None
        self._lock=threading.RLock();self._new_kernel()

    def _binding(self, gate_id: str) -> str:
        if gate_id not in self.registry:raise ValueError('unknown stable gate ID')
        return digest({'epoch':self.epoch,'gate':gate_id,'registry':self.semantic_hash,
                       'snapshot':self.snapshot,'checker':self.checker,'environment':self.environment})

    def _new_kernel(self):
        ordered=[self.registry[i] for i in self.layout.order]
        self.positions={g:i for i,g in enumerate(ordered)}
        self.kernel=Kernel([Gate(g,('epoch_snapshot','checker','environment')) for g in ordered],
            {'epoch_snapshot':digest({'snapshot':self.snapshot,'epoch':self.epoch}),
             'checker':self.checker,'environment':self.environment},self.layout.model)
        for g,evidence in self.records.items():
            if evidence.binding!=self._binding(g):raise ValueError('stale canonical evidence during rebuild')
            i=self.positions[g]
            self.kernel.submit_trusted(i,Evidence(self.kernel.gate_binding(i),evidence.status,evidence.trace_hash))

    def token(self, gate_id: str) -> StableToken:
        with self._lock:return StableToken(self.epoch,gate_id,self._binding(gate_id))

    def submit(self, token: StableToken, status: str, trace_hash: str):
        with self._lock:
            if not isinstance(token,StableToken) or token.epoch!=self.epoch or token.binding!=self._binding(token.gate_id):raise ValueError('fenced or foreign canonical evidence')
            if status not in {'PASS','FAIL','UNKNOWN'} or not isinstance(trace_hash,str) or len(trace_hash)!=64 or any(c not in '0123456789abcdef' for c in trace_hash):raise ValueError('invalid trusted result')
            g=token.gate_id;evidence=Evidence(token.binding,status,trace_hash)
            if g in self.conflicted:raise ValueError('conflict requires a new epoch')
            old=self.records.get(g)
            if old==evidence:return
            if old is not None:
                sticky='FAIL' if 'FAIL' in (old.status,status) else 'UNKNOWN'
                evidence=Evidence(token.binding,sticky,digest({'old':old.trace_hash,'new':trace_hash}))
                self.conflicted.add(g)
            self.records[g]=evidence;self._issued=None
            i=self.positions[g]
            self.kernel.submit_trusted(i,Evidence(self.kernel.gate_binding(i),evidence.status,evidence.trace_hash))
            if old is not None:raise ValueError('conflicting same-epoch evidence; publication revoked')

    def begin(self,snapshot: str):
        if not isinstance(snapshot,str) or not snapshot:raise ValueError('snapshot required')
        with self._lock:
            self.epoch+=1;self.snapshot=snapshot;self.records.clear();self.conflicted.clear()
            self._issued=None;self._new_kernel()

    def refresh(self):
        with self._lock:return self.kernel.refresh(self.layout.tree)

    def migrate(self, layout: Layout) -> dict:
        with self._lock:
            if layout.registry!=self.registry or layout.model!=self.layout.model:raise ValueError('migration cannot change acceptance contract or packet model')
            if layout.uid==self.layout.uid:
                return {'changed':False,'manifest_bytes':0,'rebuild_bytes':0,'total_bytes':0,'generation':self.generation,'packets':[]}
            self._issued=None;self.generation+=1;self.layout=layout;self._new_kernel()
            root,packets=self.kernel.refresh(layout.tree,force=True)
            manifest=len(layout.manifest_bytes());rebuild=sum(map(len,packets))
            return {'changed':True,'manifest_bytes':manifest,'rebuild_bytes':rebuild,
                    'total_bytes':manifest+rebuild,'generation':self.generation,'verdict':root.verdict,'packets':packets}

    def issue(self) -> LayoutTicket:
        with self._lock:
            if self.conflicted:raise ValueError('conflicted epoch')
            ticket=self.kernel.ticket()
            if not self.kernel.publish(ticket):raise ValueError('complete current PASS required')
            result=LayoutTicket(self.epoch,self.generation,self.semantic_hash,self.layout.uid,ticket)
            self._issued=result;return result

    def authorize(self,ticket) -> bool:
        with self._lock:
            return bool(isinstance(ticket,LayoutTicket) and self._issued==ticket and ticket.epoch==self.epoch
                        and ticket.generation==self.generation and ticket.registry==self.semantic_hash
                        and ticket.layout==self.layout.uid and not self.conflicted and self.kernel.publish(ticket.ticket))
