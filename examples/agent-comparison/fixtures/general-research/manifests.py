"""Experiment artifact provenance. Intentionally defective exercise source."""

from collections import Counter


def verify_manifest(records, manifest):
    ids = [row["id"] for row in records]
    actual = {
        "count": len(records),
        "ids": sorted(set(ids)),
        "domains": dict(sorted(Counter(row["domain"] for row in records).items())),
    }
    checks = {"unique_ids": len(ids) == len(set(ids))}
    return {"actual": actual, "checks": checks, "ok": all(checks.values())}
