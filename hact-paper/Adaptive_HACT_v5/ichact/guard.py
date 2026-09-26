"""Strict, local publication guard; the learned model is absent from its TCB.

All gates bind the complete immutable snapshot/checker/environment identities.
The trusted runner supplies records; this is not remote attestation or a sandbox.
"""
from __future__ import annotations
from dataclasses import dataclass
import threading
from hact.certificates import Kernel,Gate,Evidence,digest
from hact.tree import Node,CostModel

@dataclass(frozen=True)
class WorkToken:
    epoch:int
    gate:int
    binding:str

class EpochGuard:
    def __init__(self,registry,snapshot:str,checker:str,environment:str,model=CostModel()):
        if any(not isinstance(x,str) or not x for x in (snapshot,checker,environment)):
            raise ValueError('explicit identities required')
        gates=[Gate(g,('snapshot','checker','environment')) for g in registry]
        self.kernel=Kernel(gates,{'snapshot':snapshot,'checker':checker,'environment':environment},model)
        self.epoch=0; self._lock=threading.RLock(); self._issued=None
        self._accepted={};self._conflicted=set()

    def begin(self,snapshot:str):
        if not isinstance(snapshot,str) or not snapshot:raise ValueError('snapshot identity required')
        with self._lock:
            self.epoch+=1
            # Epoch fencing also prevents ABA replay when bytes return to an
            # earlier snapshot. No cross-epoch reuse is assumed in strict mode.
            value=digest({'snapshot':snapshot,'epoch':self.epoch})
            self.kernel.update_artifacts({'snapshot':value});self._issued=None
            self._accepted.clear();self._conflicted.clear()

    def token(self,gate:int):
        with self._lock:
            if type(gate) is not int or not 0<=gate<len(self.kernel.gates):raise ValueError('invalid gate')
            return WorkToken(self.epoch,gate,self.kernel.gate_binding(gate))

    def submit(self,token:WorkToken,status:str,trace_hash:str):
        with self._lock:
            if token.epoch!=self.epoch:raise ValueError('fenced epoch')
            evidence=Evidence(token.binding,status,trace_hash)
            if token.gate in self._conflicted:raise ValueError('conflicting evidence requires a new epoch')
            previous=self._accepted.get(token.gate)
            if previous==evidence:return  # exact delivery retry is idempotent
            if previous is not None:
                if token.binding!=self.kernel.gate_binding(token.gate):raise ValueError('stale binding')
                sticky='FAIL' if 'FAIL' in (previous.status,status) else 'UNKNOWN'
                conflict=Evidence(token.binding,sticky,digest({'previous':previous.trace_hash,'new':trace_hash}))
                self.kernel.submit_trusted(token.gate,conflict)
                self._conflicted.add(token.gate);self._issued=None
                raise ValueError('conflicting same-epoch evidence; publication revoked')
            self.kernel.submit_trusted(token.gate,evidence)
            self._accepted[token.gate]=evidence
            self._issued=None

    def refresh(self,tree:Node):
        with self._lock:return self.kernel.refresh(tree)

    def issue(self):
        with self._lock:
            ticket=self.kernel.ticket()
            if not self.kernel.publish(ticket):raise ValueError('complete current PASS required')
            self._issued=ticket;return ticket

    def authorize(self,ticket):
        with self._lock:
            return bool(self._issued is not None and ticket==self._issued and self.kernel.publish(ticket))
