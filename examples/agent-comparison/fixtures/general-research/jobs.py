"""External experiment submission ledger. Intentionally defective exercise source."""


def ensure_job(job_key, request, ledger, submit):
    job_id = submit(request)
    ledger[job_key] = {"job_id": job_id, "request": request}
    return job_id
