"""Research verification metrics. Intentionally defective exercise source."""


def verified_rate(rows):
    if not rows:
        return 0.0
    return sum(bool(row.get("verified")) for row in rows) / len(rows)
