"""Causal full-information layout selection with priced topology transitions.

Fixed-share exponential weights and maximal coupling are established primitives.
The application-specific losses are exact certificate bytes on exogenous waves.
A current event must NEVER be observed before choose() for that event.
"""
from __future__ import annotations
import copy
import math
import numpy as np
from .frontier import full_bytes


def migration_matrix(layouts):
    """Explicit cold-install upper protocol: manifest + full new-tree rebuild.

    Initial session layout installation is a common separately reported setup.
    Subsequent equal-layout choices cost zero. Neither time nor tokens are bytes.
    """
    return np.array([[0 if old.uid == new.uid else len(new.manifest_bytes()) + full_bytes(new.tree, new.model)
                      for new in layouts] for old in layouts], dtype=float)


def maximal_coupling(old, new, previous: int, rng) -> int:
    if old[previous] <= 0:
        raise ValueError('previous action has impossible probability')
    if rng.random() < min(1.0, float(new[previous] / old[previous])):
        return previous
    residual = np.maximum(new - old, 0)
    mass = float(residual.sum())
    if mass <= 0:
        raise ArithmeticError('rejected coupling has no residual probability')
    return int(rng.choice(len(new), p=residual / mass))


class CoupledShare:
    def __init__(self, k: int, loss_range: float, migration, *, eta=0.5, share=0.01, seed=0, coupled=True):
        if type(k) is not int or k < 1 or not math.isfinite(loss_range) or loss_range <= 0:
            raise ValueError('positive size and loss range required')
        if not math.isfinite(eta) or not 0 < eta <= 1 or not math.isfinite(share) or not 0 <= share < 1:
            raise ValueError('invalid learning parameters')
        matrix = np.asarray(migration, dtype=float)
        if matrix.shape != (k, k) or not np.isfinite(matrix).all() or np.any(matrix < 0) or np.any(np.diag(matrix) != 0):
            raise ValueError('nonnegative finite zero-diagonal switching matrix required')
        self.k=k; self.loss_range=float(loss_range); self.migration=matrix.copy()
        self.eta=float(eta); self.share=float(share); self.coupled=bool(coupled)
        self.rng=np.random.default_rng(seed); self.p=np.full(k, 1/k)
        self.previous_p=None; self.previous=None; self.pending=None; self.round=0
        self.service=0.0; self.switch_cost=0.0; self.switches=0

    def choose(self) -> int:
        if self.pending is not None:
            raise ValueError('observe the pending event before choosing again')
        if self.previous is None or not self.coupled:
            selected=int(self.rng.choice(self.k, p=self.p))
        else:
            selected=maximal_coupling(self.previous_p, self.p, self.previous, self.rng)
        self.pending=selected
        return selected

    def observe(self, costs) -> dict:
        if self.pending is None:
            raise ValueError('choose before observing current costs')
        values=np.asarray(costs, dtype=float)
        if values.shape != (self.k,) or not np.isfinite(values).all() or np.any(values < 0):
            raise ValueError('finite full-information cost vector required')
        centered=values-float(values.min())
        if float(centered.max()) > self.loss_range + 1e-7:
            raise ValueError('declared loss spread exceeded; do not clip measurements')
        chosen=self.pending
        price=0.0 if self.previous is None else float(self.migration[self.previous, chosen])
        record={'round':self.round, 'chosen':chosen, 'service_bytes':float(values[chosen]),
                'switch_bytes':price, 'probabilities':self.p.tolist(), 'costs':values.tolist()}
        logweights=np.log(self.p) - self.eta * centered / self.loss_range
        logweights-=float(logweights.max())
        updated=np.exp(logweights); updated/=updated.sum()
        next_p=(1-self.share)*updated+self.share/self.k
        self.previous_p=self.p.copy(); self.previous=chosen; self.p=next_p
        self.pending=None; self.round+=1; self.service+=float(values[chosen]); self.switch_cost+=price
        self.switches+=int(price>0)
        return record

    def state(self) -> dict:
        if self.pending is not None:
            raise ValueError('checkpoint only at an event boundary')
        return {'schema':1, 'k':self.k, 'loss_range':self.loss_range, 'migration':self.migration.tolist(),
                'eta':self.eta, 'share':self.share, 'coupled':self.coupled, 'p':self.p.tolist(),
                'previous_p':None if self.previous_p is None else self.previous_p.tolist(),
                'previous':self.previous, 'round':self.round, 'service':self.service,
                'switch_cost':self.switch_cost, 'switches':self.switches,
                'rng':copy.deepcopy(self.rng.bit_generator.state)}

    @classmethod
    def resume(cls, state):
        obj=cls(state['k'], state['loss_range'], state['migration'], eta=state['eta'], share=state['share'], coupled=state['coupled'])
        for key in ('p','previous_p'):
            arr=None if state[key] is None else np.asarray(state[key],dtype=float)
            if arr is not None and (arr.shape!=(obj.k,) or not np.isfinite(arr).all() or np.any(arr<=0) or not np.isclose(arr.sum(),1)):
                raise ValueError('invalid checkpoint distribution')
            setattr(obj,key,arr)
        prev=state['previous']
        if prev is not None and (type(prev) is not int or not 0<=prev<obj.k):raise ValueError('invalid previous action')
        if (prev is None)!=(obj.previous_p is None):raise ValueError('inconsistent checkpoint')
        for key in ('round','switches'):
            if type(state[key]) is not int or state[key]<0:raise ValueError('invalid checkpoint counter')
        for key in ('service','switch_cost'):
            if not math.isfinite(state[key]) or state[key]<0:raise ValueError('invalid checkpoint cost')
        for key in ('previous','round','service','switch_cost','switches'):setattr(obj,key,state[key])
        obj.rng.bit_generator.state=state['rng']
        return obj


def tracking_bound(t: int, k: int, loss_range: float, max_switch: float, eta: float, share: float, comparator_switches: int) -> float:
    """Expected regret upper bound vs a comparator's *service* cost.

    Also an upper bound vs its service+nonnegative migration cost. Requires a
    fixed catalogue, exogenous loss sequence, declared spread, and full feedback.
    This is not a per-run saving guarantee nor a new generic expert algorithm.
    """
    if t<1 or k<1 or not 0<=comparator_switches<t or not 0<eta<=1 or not 0<=share<1:
        raise ValueError('invalid theorem parameters')
    if loss_range<=0 or max_switch<0:raise ValueError('invalid theorem cost')
    s=comparator_switches
    if share==0 and s>0:return float('inf')
    complexity=math.log(k)
    if s:complexity+=s*math.log(k/share)
    if share:complexity+=(t-1-s)*(-math.log1p(-share))
    return loss_range*(complexity/eta + eta*t/8) + max_switch*(t-1)*(eta+share)


def offline_oracle(costs, migration):
    """Clairvoyant switching-cost DP, only an evaluation comparator."""
    costs=np.asarray(costs,dtype=float); migration=np.asarray(migration,dtype=float)
    if costs.ndim!=2 or not len(costs) or migration.shape!=(costs.shape[1],)*2 or not np.isfinite(costs).all() or not np.isfinite(migration).all() or np.any(costs<0) or np.any(migration<0):
        raise ValueError('invalid offline costs')
    dp=costs[0].copy(); parents=[]
    for row in costs[1:]:
        transitions=dp[:,None]+migration
        parent=transitions.argmin(axis=0); parents.append(parent)
        dp=transitions[parent,np.arange(len(row))]+row
    action=int(dp.argmin()); path=[action]
    for parent in parents[::-1]:action=int(parent[action]);path.append(action)
    return float(dp.min()),path[::-1]
