# External API admission and recovery

Foundry/Swarm treats provider unavailability as a durable wait. A model request,
its byte budget and any unknown spend remain recorded. Waiting does not become a
failed coding attempt, reset budgets or cancel an external research job.

## Admission states

| State | Admission behavior | Transition |
|---|---|---|
| Healthy | Existing shared `modelConcurrency` limit | Transient HTTP or transport failure opens a cooldown |
| Open | Worker or recovery planner yields immediately; no new API request is reserved | Durable `retry_at` expires |
| Half open | One request in the quota pool probes availability across store connections | A valid reply restores normal concurrency; a failure extends backoff |

Routes share state through the existing hashed `quotaPool`. Without an explicit
pool, the endpoint/model pair identifies the pool. Configured fallback routes
remain the same logical model and protocol; a route in cooldown is skipped so
another healthy route can respond. Providers, checks and credentials are never
selected or changed automatically beyond the configured routes.

Half-open admission also waits for old in-flight requests. A crashed probe can
be replaced after its recorded deadline; its request remains unknown spend.
Success wakes matching provider continuations early, without changing task
specifications, fences, dependencies or acceptance. An admission epoch prevents
a late success from clearing a newer outage. Recording one failure twice does
not increment the backoff twice.

## Timing and accounting

Each distinct consecutive failure backs off for 1, 2, 4, 8, 16, 32, then 60
seconds. A successful current probe resets this counter. Earlier successful
requests do not inflate the delay of the next outage.

HTTP `Retry-After` accepts numeric seconds and HTTP dates. Longer valid advice
wins over local backoff, with a host ceiling of 24 hours. Missing, invalid or
negative values use local backoff. The same policy covers normal model turns,
hedged routes and objective recovery planning. Workers release their task slot
during cooldown rather than sleeping through an attempt's deadline.

Provider permits retain the existing concurrency limit. The request timeout
starts after admission; semaphore queue time is not network time. Fetch and
response reads are explicitly raced against cancellation, including adapters
that ignore `AbortSignal`. A losing hedge cannot hold up a completed winner.
Late detached replies are disposed and cannot publish a model reply. Their
billed cost remains unknown: abandoning a host wait does not prove an external
provider stopped computing.

Authentication/configuration failures, invalid JSON and invalid response schemas
remain visible errors. Operator cancellation is not a provider outage. Request
and objective budget exhaustion still stops admission. Cooldown rejection spends
no additional request budget. Tokens and dollars are never inferred from model
text, and no error body or credential is added to recovery state.

## Observe and verify

`/swarm status` and objective health reports expose `coolingPools`, `nextRetryAt`
and up to 20 circuit details. `circuitsTruncated` marks pagination; aggregate
counts and the next deadline still include all relevant pools. The text status
panel shows the number of cooling pools and the next provider retry time.
Task status continues to show the durable wait reason and wake time.

```sh
node --experimental-strip-types --test tests/foundry/provider-recovery.test.ts
node scripts/test-swarm.mjs
node scripts/test-resilience.mjs
```

The regressions exercise persistent cooldowns, cross-connection probes, stale
successes, cancellation-resistant adapters and streams, fallbacks, recovery
planning and independently verified work during an outage. They use controlled
provider faults and actual Git/check execution. They establish host behavior;
they do not measure live-model productivity or promise that a provider returns.

Runtime scope is Foundry/Swarm. The older terminal QueryEngine uses its existing
API client and is not migrated by this change.
