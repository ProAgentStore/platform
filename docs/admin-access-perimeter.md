# The /v1/admin Cloudflare Access perimeter (#108)

Second factor in front of the operator API. `requireAdmin` — a single HS256 bearer token — is
the only thing standing between a forged/leaked session and every cross-tenant read the platform
has (all users, all instance configs, all coding timelines, all errors, all spend). Cloudflare
Access adds an SSO/hardware-key wall the bearer token cannot substitute for.

**Status: the code path is shipped and the perimeter is OFF.** Turning it on is a dashboard action
plus two secrets. The origin split is closed by the same-origin `/admin/api/*` proxy described in
§3a; read §3a before §4.

## 1. The split — what a commit can and cannot do

| Half | Who | State |
|---|---|---|
| JWT verification, the three-state gate, observability, tests | code | **done, this commit** |
| Same-origin `/admin/api/*` proxy and admin SPA relative API base | code | **done** |
| Creating the Access application, policy, and identity provider | Cloudflare dashboard, owner only | **not done** |
| Setting `CF_ACCESS_*` as Worker secrets | owner, `wrangler secret put` | **not done** |

The dashboard half is genuinely owner-only. Verified 2026-08-08 with the workspace token:

```
GET /accounts/$ACC/access/apps                  → 200, "result": []      (zero apps exist)
GET /accounts/$ACC/access/organizations         → 10000 Authentication error
GET /accounts/$ACC/access/identity_providers    → 10000 Authentication error
```

So the token can *list* Access applications but cannot read the Zero Trust organisation or its
identity providers, and therefore cannot create an application. This matches the note in
`~/dev/stores/CLAUDE.md` that the token carries Worker/R2/Pages scopes but not Zero Trust admin.
**No agent can complete step §4 — a human with dashboard access must.**

## 2. What the code does now — three states, and why

The failure mode of this perimeter is total and self-concealing: if the secrets are set but
Cloudflare is not actually injecting `Cf-Access-Jwt-Assertion` for the hostname, *every* admin
request 403s, and the portal you would use to notice is the portal that is down. Recovery means
deleting a secret and redeploying.

Whether the header arrives cannot be established from inside the Worker, from a test, or from the
dashboard. It has to be measured in production — and measuring must not be the same act as
enforcing. Hence `lib/cf-access.ts`:

| Mode | Trigger | Behaviour |
|---|---|---|
| `off` | either env var unset | No-op. **Local, dev, and prod today.** |
| `audit` | both vars set, `CF_ACCESS_ENFORCE` not truthy | Verifies the token, **records what it found, allows the request regardless.** |
| `enforce` | both vars set **and** `CF_ACCESS_ENFORCE` truthy | Missing/invalid token → 403. |

Deliberate properties:

- **Default is off**, and the default *the moment the vars appear* is `audit`, not `enforce`. A
  half-finished rollout degrades to observation, never to a lockout.
- **Enforcement is an explicit affirmative** (`1`/`true`/`yes`/`on`). Empty, `false`, `0`, and the
  literal string `undefined` a shell produces from an unset variable all mean audit. A typo in this
  secret must not be able to block anything.
- **A healthy perimeter logs nothing.** Only `missing` and `invalid` are recorded; a valid token is
  silent. A row per request would be a log nobody reads (the #423 lesson).
- **Rejections have their own source** (`cf-access`, level `warn`). Previously an Access rejection
  and an ordinary permission wall were both an anonymous 403 in `source:"unhandled"` — so "is
  Access rejecting me?" was unanswerable using the one instrument still reachable while locked out.
- **Fails closed on enforce, open on audit**, including when the JWKS fetch fails and when the
  error log itself throws. Both are covered by tests.

Read the evidence with `GET /v1/errors?scope=all&source=cf-access`, or MCP `list_errors`. **Not**
`/v1/admin/errors` — that endpoint is inside the perimeter being measured; if Access blocks at the
edge it is blocked too. Repeats collapse hourly (migration 0103), so even a rollout that fails on
every request costs ~1 row/hour.

## 3. The blocker — the admin UI and the admin API are different origins

**This is why §4 cannot simply be executed today.** Verified in code, not assumed:

| | |
|---|---|
| Admin UI | `https://proagentstore.online/admin/` — host worker (`workers/host/src/index.ts:155`), `store/admin` |
| Admin API | `https://api.proagentstore.online/v1/admin/*` — API worker |
| SPA's API base | hardcoded `https://api.proagentstore.online` (`store/admin/src/lib/api.ts:6`) |
| SPA's fetch credentials | **none** — no `credentials: "include"`, so the browser sends no cookies cross-origin |

Two consequences, in order of importance:

**a) The hostname the issue names does not exist.** #108 says "create an Access application for
`admin.proagentstore.online`". There is no such worker route (`workers/host/wrangler.toml` binds
only the apex and `console.`), and the host answers **522** — DNS resolves, nothing serves it.
An Access application on that hostname would protect nothing and change nothing.

**b) Protecting the API hostname is what would actually engage the gate — and that is the risky
one.** The Access application has to cover `api.proagentstore.online/v1/admin`, because that is
where the gate runs. But the SPA reaches it as a **cross-origin XHR that sends no cookies**, so it
cannot present an Access session. I have *not* been able to verify Cloudflare's exact response to
an unauthenticated cross-origin XHR on a protected path (I could not create an application to test
against, and I am not going to invent the behaviour). The plausible outcomes are a redirect to the
IdP — which a cross-origin `fetch()` cannot complete, surfacing as an opaque network error — or a
401/403 at the edge. **In every one of those outcomes the request never reaches the Worker.**

That has a sharp implication for how §4's verification is read:

> **Silence in the audit log is not on its own the green light.** The Worker can only record
> requests that reach it. If Access blocks at the edge, the log is silent *and* the portal is
> broken. The green light is **silence AND the portal working normally.**

The chosen remedy is the same-origin `/admin/api/*` proxy on the host worker (which already has an
`API` service binding), forwarding `Cf-Access-Jwt-Assertion` through, with the SPA's base changed
to a relative path. One Access application on `proagentstore.online/admin` covers the shell (an
interactive top-level login, which redirects fine) *and* every XHR. A smaller variant — adding
`credentials: "include"` to the admin SPA and having the operator complete the Access login once in
a top-level tab on `api.proagentstore.online` — is not the chosen path because it leaves an opaque
failure every time the Access session expires.

## 3a. The two ways to close the origin split — decided

§3 establishes that the admin UI and the admin API are different origins and that the SPA cannot
present an Access session. There are exactly two remedies. This section records both and which one
was chosen, so the decision is not re-derived at the moment someone is about to set the secrets.

**Chosen: A — a same-origin `/admin/api/*` proxy on the host worker.**

| | A — same-origin proxy | B — `credentials: "include"` |
|---|---|---|
| Access application on | `proagentstore.online`, path `admin` | `api.proagentstore.online`, path `v1/admin` |
| Code | Implemented: a proxy route on the host worker, the SPA's base to `/admin/api`, a dev-proxy entry | 1 line: `credentials: "include"` |
| CORS | none — same origin | every request preflighted, and a preflight is uncredentialed by definition |
| Session expiry | a top-level navigation redirects to the IdP and returns | an XHR gets a 302 it cannot complete; fails opaquely |
| Worst misconfiguration | whole apex behind a login (storefront + console) | whole API host behind a login (console + every runner + widget) |
| Audit signal | an edge block is a visible login page | an edge block is an opaque XHR failure with a silent log |

**Why A.** It removes the CORS question rather than configuring around it, expiry stops being a
failure mode, and an edge block becomes visible instead of silent. The parts already exist: the host
worker has an `API` service binding, the admin SPA is inlined into that same worker at build time,
and `store/admin/vite.config.ts` already proxies `/v1` in dev.

**Three implementation notes that are easy to miss:**

1. `workers/host/src/index.ts` returns `405` for every non-GET. The admin SPA POSTs and DELETEs.
   Relax it for `/admin/api/*` only — not for `/admin/*`, which is the SPA shell.
2. `/admin/api/v1/admin/me` contains no `.`, so the existing `path.startsWith("/admin/")` branch
   would answer it with the SPA shell. Register the proxy before it.
3. Forward an allowlist, not `/v1/*`. The SPA needs `/v1/admin/*`, `/v1/auth/me`, `/v1/auth/config`
   and `/v1/errors/client`. A blanket forward makes the apex a permanent second front door to the
   whole API — the proxy sends no `Origin`, so the API's CORS allowlist never applies to anything
   routed through it.

**If B is used as a stopgap**, note that it is a stopgap: the Access application needs its own CORS
settings (allowed origins, methods, headers, allow-credentials) for the preflight, and no setting
fixes expiry. The cookie itself is not the problem — `proagentstore.online` and
`api.proagentstore.online` are the same *site*, so `SameSite=Lax` still sends it cross-origin.

## 4. Runbook — ordered, with a verification per step

Steps 1–3 are dashboard; I cannot perform or verify them. Where the Cloudflare UI's exact wording
is uncertain I say so rather than inventing a label.

**1. Confirm a Zero Trust organisation and an identity provider exist.**
Cloudflare dashboard → **Zero Trust**. If prompted to choose a team name, that name becomes the
team domain `<team>.cloudflareaccess.com`, which is the value for `CF_ACCESS_TEAM_DOMAIN`.
Add an identity provider (One-time PIN needs no setup and is sufficient for a single operator;
Google/GitHub SSO is better).
*Verify:* `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` returns JSON with a `keys`
array. The gate fetches exactly this URL, so if it 404s nothing else will work.

**2. Create a self-hosted Access application covering the admin UI and proxy.**
Zero Trust → **Access → Applications → Add an application → Self-hosted**.
Domain: `proagentstore.online`, path `admin`. Path scoping matters — putting the whole hostname
behind Access would put the storefront, console, widget, sitemap and docs behind a login. Do not do
that.
*Verify:* the application's overview shows an **Application Audience (AUD) tag** — a long hex
string. That is `CF_ACCESS_AUD`.

**3. Add a policy.** Action **Allow**, rule `Emails` → the operator's address(es) only.
*Verify:* in a private window, `https://proagentstore.online/admin/` presents the Access login; a
non-allowlisted identity is refused.

**4. Set the two secrets — audit mode. This does not enforce anything.**

```bash
cd workers/api
wrangler secret put CF_ACCESS_TEAM_DOMAIN   # <team>.cloudflareaccess.com — no scheme, no trailing slash
wrangler secret put CF_ACCESS_AUD           # the AUD tag from step 2
```

*Verify, and this is the step that decides everything:* use the admin portal normally for a while,
then read `GET /v1/errors?scope=all&source=cf-access` (or MCP `list_errors`). **Not**
`/v1/admin/errors` — that endpoint is inside the perimeter being measured, so in the one failure
case where you need it most (silent log, broken portal) it is blocked along with everything else.
Repeats collapse into an existing row within the hour and bump `repeat_count` / `last_seen_at`
(migration 0103), so "nothing new" means "no bump", not "no row" — note both before you look.

| What you see | Meaning | Do |
|---|---|---|
| Rows saying `carried no Access token` / `invalid` | Requests reach the Worker without a valid JWT | **Do not enforce.** §3(b) is confirmed; the origin split needs fixing first |
| Nothing, **and the portal works normally** | Every admin request carries a valid Access JWT | Safe to proceed to step 5 |
| Nothing, **and the portal is broken** | Access is blocking at the edge before the Worker | **Do not enforce.** Fix the application/origin split; enforcing changes nothing here anyway |

**5. Only then, enforce.**

```bash
cd workers/api && wrangler secret put CF_ACCESS_ENFORCE   # value: true
```

*Verify:* the portal still works; and a request without an Access token gets 403 —

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://api.proagentstore.online/v1/admin/me
```

**Rollback, at any point:** `wrangler secret delete CF_ACCESS_ENFORCE` returns the gate to audit
(observing, blocking nothing). Deleting `CF_ACCESS_AUD` returns it to fully off. Neither needs a
code change or a redeploy of anything else.

## 5. What this does not cover

- **The MCP worker** (`mcp.proagentstore.online`) has its own OAuth2.1 + scopes + `MCP_READ_ONLY`
  and is not behind this gate.
- **`requireAdmin` still runs behind the perimeter** and remains the authorisation decision. Access
  answers "may you reach the origin", not "are you an admin" — the same two-credential split
  documented for the Rocket Lab CRM. Do not delete the role check because Access is on.
- **Service-binding callers.** Nothing calls `/v1/admin/*` over the host worker's `API` binding
  today (that binding is used for the sitemap's agent list). If one is ever added, note that a
  service-binding subrequest carries no Access JWT and would be refused under `enforce` — the
  workspace pattern for that is a shared `INTERNAL_TOKEN` header, not an Access exception.
