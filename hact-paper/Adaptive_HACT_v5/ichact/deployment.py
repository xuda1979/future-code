"""Service-matched planning arithmetic, NOT a measured network prediction.

q copies of one matched workload traverse the same non-overlapped bottleneck.
The caller supplies incremental, consistently amortized costs. Unlike an
empirical policy, this small calculator has no claim of a novel algorithm.
"""
from __future__ import annotations
from dataclasses import dataclass, asdict
from decimal import Decimal, ROUND_FLOOR
import math


def _decimal(x, label, *, positive=False):
    if isinstance(x, bool):
        raise ValueError(f'{label}: boolean is not a measurement')
    try:
        d = Decimal(str(x))
    except Exception as exc:
        raise ValueError(f'{label}: finite number required') from exc
    if not d.is_finite() or d < 0 or (positive and not d > 0):
        raise ValueError(f'{label}: finite nonnegative number required')
    return d


@dataclass(frozen=True)
class PlanningResult:
    status: str
    gain_seconds: float | None
    per_copy_gain_seconds: float | None
    minimum_profitable_copies: int | None
    reason: str
    basis: str = 'conditional_service_model_not_WAN_measurement'

    def to_dict(self):
        return asdict(self)


def assess_delivery(*, baseline_bytes: int, candidate_bytes: int,
                    goodput_bytes_per_second, copies: int,
                    extra_once_seconds, extra_per_copy_seconds=0,
                    baseline_service: str, candidate_service: str) -> PlanningResult:
    for x in (baseline_bytes, candidate_bytes, copies):
        if type(x) is not int or x < 0:
            raise ValueError('bytes and copy count must be nonnegative integers')
    for x in (baseline_service, candidate_service):
        if not isinstance(x, str) or not x.strip():
            raise ValueError('explicit service identity required')
    if baseline_service != candidate_service:
        return PlanningResult('INCOMPARABLE', None, None, None,
                              'acceptance and delivery services must match')
    values = (goodput_bytes_per_second, extra_once_seconds, extra_per_copy_seconds)
    if any(x is None for x in values):
        return PlanningResult('UNKNOWN', None, None, None,
                              'required incremental cost or goodput is missing')
    rate = _decimal(goodput_bytes_per_second, 'goodput', positive=True)
    once = _decimal(extra_once_seconds, 'once')
    extra = _decimal(extra_per_copy_seconds, 'per-copy')
    saving = Decimal(baseline_bytes - candidate_bytes) / rate - extra
    gain = copies * saving - once
    qmin = (int((once / saving).to_integral_value(rounding=ROUND_FLOOR)) + 1
            if saving > 0 else None)
    # Decimal avoids a spurious profitable verdict at an exact break-even.
    if not math.isfinite(float(gain)) or not math.isfinite(float(saving)):
        raise ValueError('planning arithmetic exceeds representable output range')
    return PlanningResult('BENEFICIAL' if gain > 0 else 'NOT_BENEFICIAL',
                          float(gain), float(saving), qmin,
                          'strictly positive gain required; zero gain retains baseline')
