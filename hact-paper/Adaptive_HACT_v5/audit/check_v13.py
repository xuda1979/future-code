"""Independent arithmetic audit of retained v13 study; no producer imports."""
from __future__ import annotations
from decimal import Decimal, localcontext
from fractions import Fraction
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def require(value, message):
    if not value:
        raise ValueError(message)


def verify(data, root=ROOT):
    require(data['schema'] == 'hact-v13-adoption-study-1', 'wrong study schema')
    counts = data['exhaustive']
    require((counts['trees'], counts['partitions'], counts['comparisons']) == (2752, 90, 247680), 'exhaustive coverage changed')
    require(counts['minimum_envelope_slack'] == 0, 'invalid envelope slack')
    synthetic = data['synthetic']
    bounds = synthetic['envelope']
    # Independent derivation: d=4*c(6)-4*c(3)-(1+h_G)*c(4), 1<=h_G<=3.
    c = lambda arity: 512 + 320 * arity
    lo = 4*c(6)-4*c(3)-4*c(4)
    hi = 4*c(6)-4*c(3)-2*c(4)
    width = hi-lo
    whole = 4 * (c(6) + c(3) + c(4))
    require((bounds['lower'], bounds['upper'], bounds['width'], bounds['whole_cost_width']) ==
            (lo, hi, width, whole), 'paired or whole envelope corrupted')
    require(synthetic['installation_bytes'] == 3684 and synthetic['horizon'] == 1000, 'installation/horizon changed')
    require(Fraction(synthetic['exact_P_maximum_drift_at_infinite_horizon']) == Fraction(1, 112), 'drift threshold corrupted')
    expected = {'P': {'-1536': '1/8', '256': '7/8'}, 'Q': {'-3328': '1/10', '256': '9/10'}}
    totals = {}
    require({x['law'] for x in synthetic['laws']} == set(expected), 'missing synthetic control law')
    for law in synthetic['laws']:
        name = law['law']
        require(law['saving_distribution'] == expected[name], 'witness saving distribution changed')
        mean = sum(Fraction(x) * Fraction(p) for x, p in expected[name].items())
        require(Fraction(law['exact_mean_bytes']) == mean, 'exact law mean corrupted')
        require(len(law['rows']) == 80, 'missing synthetic calibration rows')
        seen = set()
        for row in law['rows']:
            m, seed = row['episodes'], row['seed']
            require(m in (100, 1000, 10000, 100000) and 2026102200 <= seed < 2026102220,
                    'undeclared sample count or seed')
            require((m, seed) not in seen, 'duplicate synthetic calibration row')
            seen.add((m, seed))
            with localcontext() as context:
                context.prec = 65
                factor = (Decimal(20).ln() / (2*Decimal(m))).sqrt()
                center = Decimal(row['mean_bytes']) - Decimal(3684)/Decimal(1000)
                paired = center - Decimal(width)*factor
                unpaired = center - Decimal(whole)*factor
                require(abs(Decimal(row['paired_lower'])-paired) < Decimal('1e-50'), 'paired confidence arithmetic changed')
                require(abs(Decimal(row['whole_lower'])-unpaired) < Decimal('1e-50'), 'whole confidence arithmetic changed')
                require(row['paired_adopt'] == (paired > 0) and row['whole_adopt'] == (unpaired > 0), 'strict adoption decision changed')
        totals[name] = {str(m): {'paired': sum(r['paired_adopt'] for r in law['rows'] if r['episodes'] == m),
                                'whole': sum(r['whole_adopt'] for r in law['rows'] if r['episodes'] == m)}
                        for m in (100, 1000, 10000, 100000)}
    require(synthetic['api_no_shift']['status'] == 'CONDITIONAL_BENEFIT', 'positive API scenario changed')
    require(synthetic['api_shift_0_01']['status'] == 'RETAIN', 'drift scenario bypassed retention')
    rows = data['public_diagnostics']
    require(len(rows) == 6 and len({r['project'] for r in rows}) == 6, 'missing/duplicate public project')
    require(all(row['status'] == 'UNKNOWN' for row in rows), 'unjustified public statistical certification')
    admitted = [row for row in rows if 'dispatch_shift_saved_bytes' in row]
    require(len(admitted) == 5 and all(row['dispatch_shift_count'] == 6 for row in admitted), 'missing admitted shifts')
    values = [x for row in admitted for x in row['dispatch_shift_saved_bytes']]
    require((sum(x > 0 for x in values), sum(x == 0 for x in values), sum(x < 0 for x in values)) == (3, 18, 9),
            'historical dispatch outcomes changed')
    for row in admitted:
        envelope = row['envelope']
        require(envelope['width'] == envelope['upper'] - envelope['lower'], 'public range width changed')
        require(row['range_valid_on_retained_shifts'] and all(envelope['lower'] <= x <= envelope['upper']
                for x in row['dispatch_shift_saved_bytes']), 'public support check failed')
    for name, sha in data['inputs'].items():
        require(hashlib.sha256((root/name).read_bytes()).hexdigest() == sha, 'input/source binding changed: '+name)
    return {'status': 'PASS', 'exhaustive_comparisons': counts['comparisons'], 'synthetic_adoptions': totals,
            'public_admitted_shifts': len(values), 'public_statistically_certified_projects': 0,
            'scope': 'independent retained arithmetic and provenance; full enumeration/replay is a separate check'}


def main():
    print(json.dumps(verify(json.loads((ROOT/'results/v13/adoption.json').read_text())), indent=2))


if __name__ == '__main__':
    main()
