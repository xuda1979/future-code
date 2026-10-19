# Future Code users distribution

`users` starts from main `9028d8378c1dae94afb85ac1491ac667fb734f2e`.
The former `commercial` head was `e908f0e40cbc6e88da9d5a29e163f184448dd183`.
All product changes live under `users/` and its release workflow. Upstream runtime,
research, attribution and tests stay intact. Rebase with `git fetch origin` then
`git rebase origin/main`; packaging excludes research documents and source.

## Launch offer

| Pass | One-time price | Term | Seats | Active devices |
|---|---:|---|---:|---:|
| Solo | USD 29 | 365 days | 1 | 2 |
| Team | USD 99 | 365 days | 5 | 10 |

No automatic renewal; model API usage is paid directly to the chosen provider.
These are penetration-oriented starting hypotheses, not a measured optimum.
Measure paid conversion, activation within 24h, 30-day retained usage, refunds,
support cost and contribution margin before changing the public price. Keep
existing pass terms intact. At Stripe's published US domestic card rate of
2.9% + USD 0.30, payment processing alone is about USD 1.14 per Solo purchase;
international cards, tax, FX, email, hosting and support add costs.

## Deployment

The production catalog is at https://future-code-downloads.david-hsu-8840.chatgpt.site.
The backend uses D1, Stripe hosted Checkout and Resend. Card details go directly
to Stripe. GATC's existing Stripe account receives payouts; bank numbers never
belong in source, installers, email templates or browser code.

1. Run `node --test users/tests/*.test.mjs` (Node 24).
2. Create the tables in `commerce/schema.sql` via deployment migrations.
3. Configure server secrets `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `LICENSE_PRIVATE_KEY` (Ed25519 PKCS8 PEM), `LICENSE_STORAGE_KEY` (32 random
   bytes, base64url), and `RESEND_API_KEY`. Configure `MAIL_FROM` to a verified
   sending domain and `PUBLIC_ORIGIN` to the actual deployment origin.
4. Run `node users/scripts/configure-stripe.mjs` with the authenticated GATC
   account. Store the returned price IDs as `STRIPE_PRICE_SOLO` and
   `STRIPE_PRICE_TEAM`. This script never changes bank or payout settings.
   Use Stripe test keys and webhook secrets together before live mode.
5. Set only the public verification key and public origin in `client/config.mjs`.
   Install main's dependencies with Bun. On each native host, run
   `node users/scripts/build.mjs <platform>`. Native dependencies prevent
   treating cross-compilation alone as an OS compatibility test.
6. Test actual provider configuration, a real harmless task, tool execution,
   interruption/resume, purchase, email, activation and refunds on each OS.
   The included build smoke checks cover only startup and entitlement plumbing.
7. Resolve the imported-source notice in `docs/SOURCE_PROVENANCE.md`, retain
   required third-party notices, and record evidence in `releases.json`.
   Set each real HTTPS asset URL, SHA256 and `tested: true` only after verification.
   Set status `released` when all four native targets pass. Never invent assets.
8. Configure tax obligations in the Stripe account. Set `STRIPE_AUTOMATIC_TAX=1`
   only after Stripe Tax is configured. Verify displayed totals and published
   terms/privacy/refund information. Finally set `SALES_ENABLED=1`.

Until the artifacts and payment setup are ready, the public page displays
prelaunch status, hides download links and declines checkout without charging.
Webhook processing remains available if sales are subsequently paused so
existing paid customers can still receive their keys.

## Payment and license reliability

The published Sites page works in a browser. An automated request from the
build environment received Cloudflare HTTP 403 / error 1010. Do not use that
origin for desktop activation or register it as the live Stripe webhook until
machine ingress has been verified from the actual clients and Stripe.

An alternative host is included: `node users/commerce/server.mjs` (Node 24), or
`docker build -f users/commerce/Dockerfile -t future-code-commerce .` from the
repository root. Run it behind HTTPS with a persistent, backed-up `/data` volume
and the same server environment values. It initializes its versioned SQLite
schema at startup. It never changes existing schema during payment requests.
For an external service, set the Site's `COMMERCE_ORIGIN` to that HTTPS API host,
rebuild the desktop public `LICENSE_ORIGIN`, and register the Stripe webhook
directly on that host. Verify the full purchase path before enabling sales.
The built-in standalone rate limit uses the socket peer address, so behind a
proxy it conservatively shares a bucket; add a trusted ingress rate limiter
before expanding volume. Do not evade a provider's bot controls or put a shared
private Site bypass token into a distributed client.

Webhook HMAC verification uses the original body and a 5-minute timestamp bound.
Fulfillment retrieves the paid session from Stripe, checks live/test mode, price,
currency, quantity and amount, and records one order per Checkout session.
Key and delivery-outbox inserts are atomic. Email uses a database lease and a
stable provider idempotency key. Delivery failures return non-2xx so Stripe
retries; retain and monitor failed webhook deliveries. Resend deduplication has
a finite retention window: after an ambiguous failure older than that window,
reconcile the provider log before replaying. This is not a global exactly-once
email guarantee. A retry never creates a second license for the same session.

License keys have 256 random bits, hashed for lookup and encrypted at rest.
Device caps use an atomic conditional insert. Clients verify Ed25519 signatures,
product, device and time; receipts last at most 24h. Refund/dispute tombstones
survive out-of-order webhook delivery. Activation also checks the latest charge.
Already-issued receipts remain usable until expiry; a running offline process
cannot be remotely terminated. A shared Team key represents a pooled device
allowance, not named-user identity enforcement. Deactivation requires the key.

The receipt file contains the key for automatic refresh and uses owner-only
permissions on Unix; protect the user's Windows account/profile with its normal
ACLs. Device identifiers use random installation IDs, without hardware fingerprinting.

## Reverse engineering limits

Minified compiled executables ship without separate source maps or repository
files. Bun bytecode improves startup; its executable still contains code and
does not provide encryption or strong anti-decompilation. Public upstream source
can be copied and local entitlement checks patched. Keep signing/payment secrets,
commerce and future proprietary services on controlled servers. Actual protection
of proprietary algorithms requires implementing those algorithms as server-side
services or a separately reviewed native module; this branch makes no such claim.
Code signing/notarization improves publisher identity and install trust, not
secrecy. No anti-debugger, antivirus suppression or security bypass is used.

## Website and outreach

The company website is currently served by Squarespace (GoDaddy may manage the
domain). Add a **Future Code** navigation link to the deployed catalog. Avoid
replacing the website or changing DNS. Outreach must say prelaunch until real
downloads and checkout are verified; never advertise unbuilt OS versions as ready.
