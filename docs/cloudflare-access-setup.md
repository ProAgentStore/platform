# Turning on Cloudflare Access for the admin API (#108)

The operator's step-by-step guide. It tells you what to click, what to type, and what to look at
after each step. The *reasoning* — why the gate has three states, why the admin UI and API had to be
put on one origin first, what only production can tell you — lives in
[`admin-access-perimeter.md`](./admin-access-perimeter.md). Read that once; use this every time.

Facts in this document that were **measured on 2026-09-09** are marked as such. Anything else is
from the code.

## 1. What the gate does, and where it stands today

`cloudflareAccessGate()` in `workers/api/src/lib/cf-access.ts` is Hono middleware mounted in front of
every `/v1/admin/*` route (`workers/api/src/index.ts:147`). When configured, it requires the
`Cf-Access-Jwt-Assertion` header that Cloudflare's edge injects for a visitor who passed an Access
policy, verifies the JWT (RS256 against the team's JWKS, `aud` must match, `iss` must be the team
domain, not expired), and only then lets the request through to `requireAdmin`. Access answers "may
you reach the origin at all"; the bearer session still answers "are you an admin". Both stay.

It has three states, resolved from two secrets plus one opt-in flag:

| `adminPerimeter` | When | Behaviour |
|---|---|---|
| `off` | `CF_ACCESS_TEAM_DOMAIN` or `CF_ACCESS_AUD` unset or empty | No-op. On a deployed build, the first admin request each isolate handles prints one `console.warn` saying the gate is OFF. |
| `audit` | both set, `CF_ACCESS_ENFORCE` not an affirmative | Verifies the token, **records** a missing or invalid one in the error log (source `cf-access`), and **allows the request anyway**. |
| `enforce` | both set **and** `CF_ACCESS_ENFORCE` is `1`, `true`, `yes` or `on` | Missing or invalid token → `403`. |

Two properties are worth holding in mind throughout:

- **Setting the two secrets alone cannot lock you out.** It lands you in `audit`, which never blocks.
  Enforcement is a third, separate secret with an explicit affirmative value; `""`, `false`, `0` and
  the literal string `undefined` all still mean `audit`.
- **A healthy perimeter is silent.** In `audit` and `enforce`, a valid token writes nothing. Only
  `missing` and `invalid` are recorded, and repeats collapse into one row per hour.

**State on 2026-09-09 (measured):** `adminPerimeter` is `off` in production. `wrangler secret list`
on `proagentstore-api` shows 14 secrets and none named `CF_ACCESS_*`. The same-origin admin proxy is
live: `https://proagentstore.online/admin/api/v1/admin/me` answers `401`, and a path outside its
allowlist answers `404`.

## 2. Prerequisites

| Need | Status (measured 2026-09-09) |
|---|---|
| A Zero Trust organisation on the Cloudflare account | Exists. Account `c1089bfcc43c1c6c2aa89e584e86f0bc`; six self-hosted Access applications already exist on it (the sibling stores' admin apps). |
| The team domain | **`ozai-digital.cloudflareaccess.com`**. Discovered from the `302` an unauthenticated request to a sibling Access-protected path receives. This is the value for `CF_ACCESS_TEAM_DOMAIN`. |
| The JWKS the gate fetches | Live: `https://ozai-digital.cloudflareaccess.com/cdn-cgi/access/certs` returns two RS256 keys. |
| An identity provider | At least one exists — the "FWS Admin" application references one by id — but the API lists none and cannot read it, so its type is unconfirmed. Confirm it in the dashboard (step 3.1). |
| The admin UI and API on one origin | Done. `store/admin` calls `/admin/api`, which the host worker proxies to the API worker and forwards `Cf-Access-Jwt-Assertion`. |
| Dashboard access to Zero Trust | The owner's browser session. Needed for step 3.1 and, if you do not use the API route in 3.5, for 3.2–3.4. |
| A machine with `wrangler` logged in as the owner | The `wrangler whoami` login used for deploys has `workers (write)`, which is what `wrangler secret put` needs. |
| The SOPS age key | `~/.config/sops/age/keys.txt`. On this machine `sops` does not find it by default; prefix commands with `SOPS_AGE_KEY_FILE=$HOME/.config/sops/age/keys.txt`. |

**Where the values will live.** There is **no Doppler** for this project — the workspace moved to
SOPS, and the stale "Doppler `pags/prd`" instruction in the issue body has already cost one agent a
dead end. There is also **no staging environment**: `workers/api/wrangler.toml` defines no
`[env.*]`, so there is exactly one deployed API worker, `proagentstore-api`, and it is production.
The values are Worker runtime secrets, recorded in `~/dev/secrets` (see step 4.1) so they are
recoverable.

## 3. Create the Access application

### 3.1 Confirm the identity provider

Cloudflare dashboard → **Zero Trust** → **Settings** → **Authentication** → **Login methods**.

- If a login method is listed (One-time PIN, Google, GitHub, …), note which. That is what the
  operator will sign in with.
- If none is listed, add **One-time PIN**. It needs no configuration and is sufficient for a single
  operator; Google or GitHub SSO is stronger and can be added later.

*Verify:* the login method appears in the list. (The API cannot confirm this for you — measured
2026-09-09, `GET /access/identity_providers` returns an empty list even though an application
references a provider by id.)

### 3.2 Add the application

Zero Trust → **Access** → **Applications** → **Add an application** → **Self-hosted**.

| Field | Value | Why |
|---|---|---|
| Application name | `PAGS Admin` | Free text. Keep the sibling convention (`FWS Admin`). |
| Session duration | `24h` | Matches the sibling apps. An expired session on a top-level navigation just redirects to the login and back. |
| Application domain | **`proagentstore.online`**, path **`admin`** | The admin SPA and its `/admin/api/*` proxy both live under this path on the apex, so one application covers the shell and every XHR. |

Three things **not** to enter, each of which has been tried or proposed and is wrong:

- **Not `admin.proagentstore.online`.** The issue body names it; it does not exist (answers `522`).
  An application there protects nothing.
- **Not the whole `proagentstore.online` hostname** (path left empty). That puts the public
  storefront, `/agents/*`, `/console/`, `/widget.js`, `/sitemap.xml` and the docs behind a login.
  Visible instantly from any browser and reversible in the dashboard, but do not do it.
- **Not `api.proagentstore.online`.** The gate runs there, but the SPA reaches it through the
  same-origin proxy, which forwards the header. Protecting the API host directly would break the
  console, every `pags up` runner, the widget and public trial chat.

Leave the CORS settings empty: same origin means no preflight, which is the whole reason the proxy
was built.

### 3.3 Add the policy

On the same application, **Add a policy**:

| Field | Value |
|---|---|
| Policy name | `Allow operator` |
| Action | **Allow** |
| Include | **Emails** → the operator's address(es) only |

Do **not** use `Everyone`. The sibling `FWS Admin` application's policy is `allow: everyone`
(measured 2026-09-09), which admits any identity that can complete the login method. For an admin
portal the allowlist is the point.

### 3.4 Copy the Application Audience tag

Save, then open the application's **Overview**. The **Application Audience (AUD) Tag** is a 64-character
hex string. That is `CF_ACCESS_AUD`. Copy it somewhere you will paste from in step 4, not into a
chat.

*Verify, before touching any secret:* in a private browser window open
`https://proagentstore.online/admin/`. You should be sent to a login page on
`ozai-digital.cloudflareaccess.com`. Sign in with a non-allowlisted identity: you must be refused.
Sign in as the operator: the admin portal loads and works normally. If the portal loads **without**
any login page, the application's domain or path is wrong; fix that before continuing, because the
gate cannot distinguish "no application" from "wrong application" — both look like `missing`.

### 3.5 Alternative: create the application by API

The Cloudflare API can create the application and policy, and the values it returns include the
AUD tag, which saves the copy step. Measured 2026-09-09: the account's `pdocs-prd` token (ProDocStore's,
stored under `["pdocs"]["CLOUDFLARE_API_TOKEN"]` in `~/dev/secrets/secrets.enc.yaml`) lists Access
applications successfully; the PAGS token `pags-prd` has no Access permissions and no stored value.
Using a token scoped for another project on PAGS infrastructure is a decision for the owner, so this
route is documented rather than recommended. The identity-provider step (3.1) is not automatable
either way. If you take this route:

```bash
ACC=c1089bfcc43c1c6c2aa89e584e86f0bc
export SOPS_AGE_KEY_FILE=$HOME/.config/sops/age/keys.txt
cd ~/dev/secrets && sops -d --extract '["pdocs"]["CLOUDFLARE_API_TOKEN"]' secrets.enc.yaml | {
  read -r T
  curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACC/access/apps" \
    -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
    --data '{"name":"PAGS Admin","type":"self_hosted","domain":"proagentstore.online/admin","session_duration":"24h","auto_redirect_to_identity":true,"policies":[{"name":"Allow operator","decision":"allow","include":[{"email":{"email":"OPERATOR@EXAMPLE.COM"}}]}]}' \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print("success:", d["success"]); print("aud:", (d.get("result") or {}).get("aud")); print("errors:", d.get("errors"))'
}
```

Replace the operator email. The `aud` printed is `CF_ACCESS_AUD`. Then run the private-window
verification from 3.4 exactly as written.

## 4. Set the secrets

### 4.1 Record the values first

`~/dev/secrets` is the map and the vault; the rule there is that a secret gets an inventory entry
before it exists anywhere else. Add to `inventory.yaml` under the `pags:` list:

```yaml
  - key: CF_ACCESS_TEAM_DOMAIN
    provider: cloudflare
    note: Not secret — Zero Trust team domain (ozai-digital.cloudflareaccess.com). The gate fetches /cdn-cgi/access/certs from it.
    consumers:
      - wrangler-secret: proagentstore-api
    created: YYYY-MM-DD
    rotates: never
  - key: CF_ACCESS_AUD
    provider: cloudflare
    provider_url: https://one.dash.cloudflare.com/  # Zero Trust → Access → Applications → PAGS Admin → Overview
    note: Application Audience tag of the "PAGS Admin" Access application (proagentstore.online/admin). Changes only if the application is recreated.
    consumers:
      - wrangler-secret: proagentstore-api
    created: YYYY-MM-DD
    rotates: never
```

Then store both values (the editor opens decrypted and re-encrypts on save; add them under the
top-level `pags:` key):

```bash
cd ~/dev/secrets
SOPS_AGE_KEY_FILE=$HOME/.config/sops/age/keys.txt sops secrets.enc.yaml
```

The AUD is not a credential — it is the *name* of the application the token must be minted for — but
it is recorded here so a redeploy from a fresh machine never has to re-derive it from the dashboard.

### 4.2 Production: `wrangler secret put` on `proagentstore-api`

Pipe from SOPS so the values never sit in a shell history. `wrangler secret put` creates a new
deployment of the worker immediately; no CI run is needed.

```bash
cd ~/dev/secrets
export SOPS_AGE_KEY_FILE=$HOME/.config/sops/age/keys.txt
API=~/dev/pags/platform/workers/api   # or wherever this repo is checked out

sops -d --extract '["pags"]["CF_ACCESS_TEAM_DOMAIN"]' secrets.enc.yaml \
  | (cd "$API" && pnpm exec wrangler secret put CF_ACCESS_TEAM_DOMAIN)
sops -d --extract '["pags"]["CF_ACCESS_AUD"]' secrets.enc.yaml \
  | (cd "$API" && pnpm exec wrangler secret put CF_ACCESS_AUD)
```

Value shapes, because the gate checks them literally:

- `CF_ACCESS_TEAM_DOMAIN` is the bare host: `ozai-digital.cloudflareaccess.com`. No `https://`, no
  trailing slash. The gate builds `https://<value>/cdn-cgi/access/certs` and compares the JWT's
  `iss` to `https://<value>`.
- `CF_ACCESS_AUD` is the 64-character hex tag, nothing else.

**Do not set `CF_ACCESS_ENFORCE` yet.** With only the two values above the gate is in `audit`.

*Verify:* `pnpm exec wrangler secret list` in `workers/api` names both. Then go to §5.

### 4.3 Local development: `.dev.vars` (optional)

Locally the gate should normally stay `off`: there is no Cloudflare edge in front of `wrangler dev`,
so nothing injects the header, and `audit` would only ever log `missing`. Local runs also never print
the "gate is OFF" warning, because `wrangler.toml` sets `API_BUILD = "dev"` and the warning is gated
on a real build SHA.

If you want to exercise `audit` or `enforce` locally — for example to see the `cf-access` rows appear
in `/v1/errors` — create `workers/api/.dev.vars`, which `wrangler dev` reads as secrets:

```
CF_ACCESS_TEAM_DOMAIN=ozai-digital.cloudflareaccess.com
CF_ACCESS_AUD=<the tag>
```

`.dev.vars` is **not** covered by the repo's `.gitignore` (it lists `.env` and `.env.*` only), so
check `git status` before committing. Every local admin request will then be recorded as `missing`,
which is the correct answer for a request that never crossed the edge.

## 5. Verify the gate is active

### 5.1 `/health` — the state, without a credential

```bash
curl -s https://api.proagentstore.online/health
```

```json
{"ok":true,"service":"proagentstore-api","adminPerimeter":"audit"}
```

`adminPerimeter` is the gate's resolved mode. After step 4.2 it must read `audit`. If it still reads
`off`, one of the two secrets is missing or empty — see §6. The deploy workflow already probes this
endpoint after every deploy, so the value is in the deploy log too.

### 5.2 The warning, on a deployed build

While `adminPerimeter` is `off`, every production isolate says so once, on the first admin request it
serves:

```
[cf-access] gate is OFF — CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are unset; admin routes are unprotected
```

You can watch for it with `cd workers/api && pnpm exec wrangler tail --format pretty` while loading
the admin portal. Once the secrets are set the line stops appearing — its absence on a fresh isolate
is a second confirmation of `audit`.

### 5.3 The soak — the step that decides everything

Use the admin portal normally for a while (a day is plenty; the SPA polls, so even an hour produces
hundreds of admin requests). Then read the perimeter's own log:

```bash
# outside the perimeter on purpose — /v1/admin/errors is inside the thing being measured
curl -s -H "Authorization: Bearer $SESSION" \
  "https://api.proagentstore.online/v1/errors?scope=all&source=cf-access"
```

or MCP `list_errors` with `source: "cf-access"`. Repeats collapse into an existing row within the
hour and bump `repeat_count` / `last_seen_at`, so note both **before** the soak: "nothing new" means
"no bump", not "no row".

| What you see | Meaning | Do |
|---|---|---|
| No new or bumped `cf-access` row, **and the portal works normally** | Every admin request carried a valid Access JWT | Proceed to 5.4 |
| Rows saying `carried no Access token` | Requests reach the Worker without the header | **Do not enforce.** The application does not cover the path the requests take, or the proxy is not forwarding the header. §6. |
| Rows saying `carried an invalid Access token` | The header arrives but fails verification | **Do not enforce.** `aud` or team domain is wrong, or the JWKS is unreachable. §6. |
| Silent, **and the portal is broken** | Access is blocking at the edge, before the Worker | **Do not enforce.** With the same-origin proxy this shows as a visible login page, not a silent failure — fix the application. |

### 5.4 Enforce

Only after row 1 of the table:

```bash
cd workers/api && printf 'true' | pnpm exec wrangler secret put CF_ACCESS_ENFORCE
```

*Verify:*

```bash
curl -s https://api.proagentstore.online/health          # → "adminPerimeter":"enforce"
curl -s -o /dev/null -w '%{http_code}\n' https://api.proagentstore.online/v1/admin/me   # → 403
```

The second line is the negative test the issue asks for: a request with no Access token is refused
at the gate, before session auth (it was `401` while the gate was off or auditing). Then, in a
private window, confirm the portal still loads through the login and a non-allowlisted identity is
still refused.

### 5.5 Rollback, at any point

| Command (in `workers/api`) | Result |
|---|---|
| `pnpm exec wrangler secret delete CF_ACCESS_ENFORCE` | Back to `audit`: observing, blocking nothing |
| `pnpm exec wrangler secret delete CF_ACCESS_AUD` | Back to `off`: gate inert |

Each is one command, takes effect on the next request, and needs no code change or redeploy. The
Access application itself can stay; with the gate `off` it only protects the SPA shell.

## 6. Troubleshooting

**`adminPerimeter` still says `off` after `wrangler secret put`.**
The gate treats an empty string as unset. Check `wrangler secret list` names both, and re-put the
value that might have been pasted empty (a `printf '' |` pipe, or a `sops` extract of a key that does
not exist yet, both produce an empty secret). Also confirm you are reading the deployed worker and
not `wrangler dev`, which is always `off` unless `.dev.vars` says otherwise.

**Every admin request is `403` and the portal is a wall of errors.**
You are in `enforce` and the header is not arriving or not verifying. This is the state the three
modes exist to prevent; get out first, diagnose second:
`pnpm exec wrangler secret delete CF_ACCESS_ENFORCE`. The gate drops to `audit`, the portal works
again, and the `cf-access` rows in `/v1/errors` now tell you which of the two failures it is.

**The whole site is behind a login page.**
The application's path is empty. Zero Trust → Access → Applications → PAGS Admin → edit the domain
to path `admin`. Reversible in under a minute.

**`/v1/errors` shows `carried no Access token` rows.**
The Worker is receiving admin requests with no header. Causes, most likely first:

- The Access application does not cover the path the requests take. It must be
  `proagentstore.online` / `admin`. In a private window `https://proagentstore.online/admin/` must
  show the login page; if it loads directly, the application is not matching.
- The requests are not going through the proxy. The admin SPA's base is `/admin/api`; a client
  calling `https://api.proagentstore.online/v1/admin/...` directly (an old bookmark, a script, a curl)
  never crosses the Access application and will always be `missing`. Under `enforce` such callers are
  refused, which is the intended outcome — but find them before enforcing.
- The host worker's proxy is not forwarding `Cf-Access-Jwt-Assertion`. It is in the forwarded-header
  allowlist in `workers/host/src/index.ts`; a regression there presents exactly as `missing`.

**`/v1/errors` shows `carried an invalid Access token` rows.**
The header arrives but verification fails. In order of frequency:

- `CF_ACCESS_AUD` is the tag of a different application, or has a stray character. Compare against
  the application's Overview page; the gate requires the JWT's `aud` array to contain the value
  exactly.
- `CF_ACCESS_TEAM_DOMAIN` has a scheme or trailing slash, or names a different team. The JWT's `iss`
  must equal `https://ozai-digital.cloudflareaccess.com` exactly.
- The JWKS fetch failed. From inside the verifier that is a `503`, which resolves to `invalid`
  (fail-closed under `enforce`, fail-open under `audit`). Check
  `curl https://ozai-digital.cloudflareaccess.com/cdn-cgi/access/certs` returns a `keys` array.
  The gate caches the JWKS for an hour per isolate, so a key rotation can produce a short burst of
  `invalid` rows that clears itself.
- The token has expired. Sessions are 24h; a top-level navigation renews them. If a *background* poll
  keeps failing after the session expired, reloading the portal fixes it.

**The portal works in one browser and not another.**
Access sessions are per browser. The other browser needs to complete the login once; the SPA's
requests then carry the session cookie because they are same-origin.

**Nothing in `/v1/errors` and the portal is fine, but you are not sure the gate is actually seeing
tokens.**
That silence *is* the healthy signal — a valid token writes nothing by design. The two positive
confirmations are `adminPerimeter: "audit"` on `/health` and the absence of the "gate is OFF" line in
`wrangler tail` on a fresh isolate. If you want a deliberate negative, call
`https://api.proagentstore.online/v1/admin/me` directly with `curl` and a session token: that request
bypasses the proxy, so under `audit` it succeeds *and* writes one `missing` row, proving the gate
observed it.

**MCP `list_errors` and other non-admin surfaces.**
Unaffected. The gate mounts only on `/v1/admin/*`; `/v1/errors`, the MCP worker and every runner
path are outside it, which is why `/v1/errors` is the diagnostic to use even when the portal is down.
