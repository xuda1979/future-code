"""Conditional padded-byte adoption advice; never acceptance or migration.

Shared semantic-coverage packets cancel before the paired-cost range is
bounded. A one-sided finite-catalogue Hoeffding bound, an externally justified
TV radius and installation amortization yield a conditional expected benefit.
The caller must establish the sampling and pre-calibration freeze assumptions;
this module cannot infer them from repeated traces or an assertion string.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from decimal import Decimal, localcontext
from typing import Iterable, Sequence

from hact.certificates import canonical, digest
from ichact.layout import Layout


def _decimal(value, name):
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        raise ValueError(f"finite numeric {name} required")
    try:
        result = Decimal(str(value))
    except Exception as error:
        raise ValueError(f"finite numeric {name} required") from error
    if not result.is_finite():
        raise ValueError(f"finite numeric {name} required")
    return result


@dataclass(frozen=True)
class AdoptionPlan:
    incumbent: Layout
    candidates: tuple[Layout, ...]
    max_wave_width: int
    wave_count: int
    delta: str
    shift_radius: str | None
    horizon: int
    installation_bytes: tuple[int, ...]

    def __post_init__(self):
        if not isinstance(self.incumbent, Layout) or not isinstance(self.candidates, tuple) or not self.candidates:
            raise ValueError("a fixed nonempty layout catalogue is required")
        if any(not isinstance(x, Layout) or x.registry != self.incumbent.registry
               or x.model != self.incumbent.model for x in self.candidates):
            raise ValueError("registry and packet contracts must match")
        if len({x.uid for x in self.candidates}) != len(self.candidates):
            raise ValueError("duplicate candidate layouts")
        if any(type(x) is not int or x < 1 for x in
               (self.max_wave_width, self.wave_count, self.horizon)):
            raise ValueError("positive integer support and horizon required")
        n = len(self.incumbent.registry)
        if not self.wave_count <= n <= self.wave_count * self.max_wave_width:
            raise ValueError("complete-epoch support is infeasible")
        if not isinstance(self.installation_bytes, tuple) or len(self.installation_bytes) != len(self.candidates) or any(
                type(x) is not int or x < 0 for x in self.installation_bytes):
            raise ValueError("nonnegative integer installation bytes required per candidate")
        if not 0 < _decimal(self.delta, "delta") < 1:
            raise ValueError("delta must be strictly between zero and one")
        if self.shift_radius is not None and not 0 <= _decimal(self.shift_radius, "shift radius") <= 1:
            raise ValueError("TV radius must lie in [0,1]")

    @property
    def uid(self):
        return digest({"schema": "hact-adoption-plan-1", "incumbent": self.incumbent.uid,
                       "candidates": [x.uid for x in self.candidates],
                       "max_wave_width": self.max_wave_width, "wave_count": self.wave_count,
                       "delta": str(self.delta), "shift_radius": None if self.shift_radius is None else str(self.shift_radius),
                       "horizon": self.horizon, "installation_bytes": list(self.installation_bytes)})


def packet_difference(incumbent: Layout, candidate: Layout):
    """Exact integer coefficients indexed by semantic bitset, not display order."""
    if incumbent.registry != candidate.registry or incumbent.model != candidate.model:
        raise ValueError("registry and packet contracts must match")
    coefficients = Counter()
    for mask, price in incumbent.coverage():
        coefficients[mask] += price
    for mask, price in candidate.coverage():
        coefficients[mask] -= price
    return {mask: price for mask, price in sorted(coefficients.items()) if price}


def difference_envelope(incumbent, candidate, *, max_wave_width, wave_count):
    """Conservative support envelope, valid beyond observed calibration epochs.

    A subset of s checks hits at least ceil(s/w) waves, and at least q-(n-s)
    because every other nonempty wave consumes a distinct complement check.
    Its upper bound is min(s,q). Bounds for different subsets need not be jointly
    attainable, so the resulting envelope is not claimed sharp.
    """
    n = len(incumbent.registry)
    if any(type(x) is not int or x < 1 for x in (max_wave_width, wave_count)) or not wave_count <= n <= wave_count * max_wave_width:
        raise ValueError("invalid complete-epoch support")
    coefficients = packet_difference(incumbent, candidate)
    lower = upper = sum(coefficients.values())  # one cold build per epoch
    terms = []
    for mask, price in coefficients.items():
        size = mask.bit_count()
        lo = max((size + max_wave_width - 1) // max_wave_width, wave_count - (n - size))
        hi = min(size, wave_count)
        lower += price * (lo if price > 0 else hi)
        upper += price * (hi if price > 0 else lo)
        terms.append({"coverage": mask, "coefficient": price, "hit_lower": lo, "hit_upper": hi})
    whole = (wave_count + 1) * (sum(x[1] for x in incumbent.coverage()) +
                               sum(x[1] for x in candidate.coverage()))
    return {"lower": lower, "upper": upper, "width": upper - lower,
            "whole_cost_width": whole, "terms": terms}


def _complete_masks(episode, n, width, count):
    if not isinstance(episode, Sequence) or isinstance(episode, (str, bytes)) or len(episode) != count:
        raise ValueError("exact declared number of nonempty waves required")
    seen, masks = set(), []
    for wave in episode:
        if not isinstance(wave, Sequence) or isinstance(wave, (str, bytes)) or not 1 <= len(wave) <= width:
            raise ValueError("nonempty bounded-width wave required")
        mask = 0
        for i in wave:
            if type(i) is not int or not 0 <= i < n or i in seen:
                raise ValueError("invalid, repeated or foreign canonical completion")
            seen.add(i)
            mask |= 1 << i
        masks.append(mask)
    if len(seen) != n:
        raise ValueError("incomplete verification epoch")
    return masks


def paired_savings(plan: AdoptionPlan, calibration):
    if not isinstance(calibration, Sequence) or isinstance(calibration, (str, bytes)) or not calibration:
        raise ValueError("nonempty calibration episodes required")
    coefficients = [packet_difference(plan.incumbent, x) for x in plan.candidates]
    rows = [[] for _ in plan.candidates]
    for episode in calibration:
        masks = _complete_masks(episode, len(plan.incumbent.registry), plan.max_wave_width, plan.wave_count)
        for row, terms in zip(rows, coefficients):
            row.append(sum(price * (1 + sum(bool(mask & wave) for wave in masks))
                           for mask, price in terms.items()))
    return rows


def summarize_calibration(plan: AdoptionPlan, calibration):
    """One-pass exact scoring: O(K) totals, no retained per-epoch loss rows.

    Coverage coefficients/layouts and one epoch's masks are additional storage.
    Raw provenance may still have to be archived by a separate evidence service.
    Streaming changes neither the IID assumption nor the freeze requirement.
    """
    if not isinstance(calibration, Iterable) or isinstance(calibration, (str, bytes)):
        raise ValueError("calibration episodes must be iterable")
    coefficients = [packet_difference(plan.incumbent, x) for x in plan.candidates]
    envelopes = [difference_envelope(plan.incumbent, x, max_wave_width=plan.max_wave_width,
                                    wave_count=plan.wave_count) for x in plan.candidates]
    totals, count = [0] * len(coefficients), 0
    for episode in calibration:
        masks = _complete_masks(episode, len(plan.incumbent.registry), plan.max_wave_width, plan.wave_count)
        for index, (terms, envelope) in enumerate(zip(coefficients, envelopes)):
            value = sum(price * (1 + sum(bool(mask & wave) for wave in masks)) for mask, price in terms.items())
            if not envelope['lower'] <= value <= envelope['upper']:
                raise AssertionError("paired scorer escaped its support envelope")
            totals[index] += value
        count += 1
    if not count:
        raise ValueError("nonempty calibration episodes required")
    return {"episodes": count, "totals": totals, "envelopes": envelopes}


def assess_adoption(plan: AdoptionPlan, calibration, *, frozen_plan_digest=None,
                    sampling_justification=None):
    """Retain on uncertainty/ties; every benefit statement remains conditional.

    A matching digest binds configuration, not its chronology. An operator
    must retain an actual pre-calibration receipt and justify independent IID
    calibration. Missing evidence gives UNKNOWN. No function here writes gate
    state, grants PASS, runs a checker or installs a layout.
    """
    if frozen_plan_digest is not None and frozen_plan_digest != plan.uid:
        raise ValueError("pre-calibration adoption-plan binding mismatch")
    if sampling_justification is not None and (not isinstance(sampling_justification, str) or not sampling_justification.strip()):
        raise ValueError("sampling justification must be a nonempty string")
    summary = summarize_calibration(plan, calibration)
    ready = frozen_plan_digest is not None and sampling_justification is not None and plan.shift_radius is not None
    rows, best = [], None
    with localcontext() as context:
        context.prec = 80
        m, k = Decimal(summary['episodes']), Decimal(len(plan.candidates))
        factor = ((k / _decimal(plan.delta, "delta")).ln() / (2 * m)).sqrt()
        for index, (candidate, total, install, envelope) in enumerate(zip(
                plan.candidates, summary['totals'], plan.installation_bytes, summary['envelopes'])):
            mean = Decimal(total) / m
            radius = Decimal(envelope["width"]) * factor
            drift = None if plan.shift_radius is None else Decimal(envelope["width"]) * _decimal(plan.shift_radius, "shift radius")
            lower = None
            if drift is not None:
                # Decimal ln/sqrt are correctly rounded; a deliberately much
                # larger downward guard prevents a numerical near-tie promotion.
                guard = max(Decimal(1), abs(mean), radius, drift, Decimal(install)) * Decimal("1e-60")
                support_lower = max(Decimal(envelope["lower"]), mean - radius - drift - guard)
                lower = support_lower - Decimal(install) / Decimal(plan.horizon) - guard
            eligible = ready and lower > 0
            row = {"layout": candidate.uid, "envelope": envelope, "episodes": summary['episodes'],
                   "mean_saved_bytes": str(mean), "sampling_penalty_bytes": str(radius),
                   "shift_penalty_bytes": None if drift is None else str(drift),
                   "installation_bytes": install, "horizon": plan.horizon,
                   "lower_net_expected_bytes_per_epoch": None if lower is None else str(lower),
                   "status": "CONDITIONAL_BENEFIT" if eligible else "RETAIN" if ready else "UNKNOWN"}
            rows.append(row)
            if eligible and (best is None or lower > best[0]):
                best = lower, index
    result = {"schema": "hact-adoption-advice-1", "plan": plan.uid,
              "status": "CONDITIONAL_BENEFIT" if best else "RETAIN" if ready else "UNKNOWN",
              "selected": plan.incumbent.uid if best is None else plan.candidates[best[1]].uid,
              "incumbent": plan.incumbent.uid, "candidates": rows,
              "sampling_justification": sampling_justification,
              "scope": "conditional expected padded bytes only; caller establishes freeze, IID, independence and same-support TV assumptions; no acceptance or deployment authority"}
    canonical(result)  # reject accidental non-serializable evidence
    return result
