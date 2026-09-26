"""Deterministic priced-window selector. No adversarial regret claim.

A runtime implementation of the frozen v3 64-event baseline. choose() must
precede observe(); every observation is an exogenous, full-information vector.
Checkpoint only at event boundaries. Compilation is NEVER done by this policy.
"""
from __future__ import annotations
from collections import deque
import math
import numpy as np

class PricedWindow:
    def __init__(self, migration, *, initial=0, window=64):
        m=np.asarray(migration,dtype=float)
        if m.ndim!=2 or not len(m) or m.shape[0]!=m.shape[1] or not np.isfinite(m).all() or np.any(m<0) or np.any(np.diag(m)!=0):
            raise ValueError('finite nonnegative square migration matrix with zero diagonal required')
        if type(initial) is not int or not 0<=initial<len(m) or type(window) is not int or window<1:
            raise ValueError('invalid initial layout or window')
        self.migration=m.copy();self.active=initial;self.window=window
        self.history=deque(maxlen=window);self.round=0;self.pending=None
        self.service=0.;self.switch_cost=0.;self.switches=0

    def choose(self):
        if self.pending is not None:raise ValueError('observe the current event first')
        chosen=self.active
        if self.history:
            means=np.mean(np.asarray(self.history),axis=0)
            proposal=int(np.argmin(means))
            if self.window*(means[self.active]-means[proposal])>self.migration[self.active,proposal]:
                chosen=proposal
        self.pending=chosen
        return chosen

    def observe(self,costs):
        if self.pending is None:raise ValueError('choose before observe')
        v=np.asarray(costs,dtype=float)
        if v.shape!=(len(self.migration),) or not np.isfinite(v).all() or np.any(v<0):
            raise ValueError('finite nonnegative full-information costs required')
        chosen=self.pending;price=float(self.migration[self.active,chosen])
        rec={'round':self.round,'chosen':chosen,'service_bytes':float(v[chosen]),'switch_bytes':price}
        self.service+=float(v[chosen]);self.switch_cost+=price;self.switches+=int(chosen!=self.active)
        self.active=chosen;self.pending=None;self.round+=1;self.history.append(v.copy())
        return rec

    def state(self):
        if self.pending is not None:raise ValueError('checkpoint only between events')
        return {'schema':'priced-window-1','migration':self.migration.tolist(),'active':self.active,'window':self.window,
                'history':[v.tolist() for v in self.history],'round':self.round,'service':self.service,
                'switch_cost':self.switch_cost,'switches':self.switches}

    @classmethod
    def resume(cls,s):
        if not isinstance(s,dict) or s.get('schema')!='priced-window-1':raise ValueError('invalid schema')
        o=cls(s['migration'],initial=s['active'],window=s['window'])
        if type(s['round']) is not int or s['round']<0 or type(s['switches']) is not int or not 0<=s['switches']<=s['round']:
            raise ValueError('invalid counters')
        if not isinstance(s['history'],list) or len(s['history'])!=min(s['round'],s['window']):raise ValueError('inconsistent history')
        for v in s['history']:
            a=np.asarray(v,dtype=float)
            if a.shape!=(len(o.migration),) or not np.isfinite(a).all() or np.any(a<0):raise ValueError('invalid history')
            o.history.append(a.copy())
        for k in ('service','switch_cost'):
            if isinstance(s[k],bool) or not isinstance(s[k],(int,float)) or not math.isfinite(s[k]) or s[k]<0:raise ValueError('invalid ledger')
        o.round=s['round'];o.service=s['service'];o.switch_cost=s['switch_cost'];o.switches=s['switches']
        return o
