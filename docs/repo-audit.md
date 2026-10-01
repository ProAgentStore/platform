# Store org & repo audit — naming standard and consolidation (#900)

Status: **proposal, nothing executed.** Every rename, merge, archive or deletion below needs Serge's
approval and its own ticket. Items that need Serge at the GitHub org-settings level are marked
**🔴 needs-human (Serge)**.

Snapshot taken 2026-10-01 with `gh repo list <org> --limit 1000` against every store-family org
the `serge-ivo` account belongs to, plus `gh api repos/<slug>/contents` (top-level tree, workflows,
README) on every non-product repo. Raw counts are from that snapshot. Expect them to drift.

---

## 0. Summary

- **29 store-family orgs, 727 repos (194 archived).** Two orgs hold 71% of them:
  `freegamestore-online` (322, of which 175 archived, including 137 `e2e-create-*` test
  fixtures) and `freeappstore-online` (196).
- **Org casing:** 24 orgs use lowercase `<store>-online`. Five deviate: `ProAgentStore`,
  `FreeAgentStore` and `FreeDocStore` (PascalCase, no `-online`), plus `ProDocStore-online` and
  `HeartFull-online` (`-online` with mixed case). GitHub matches org and repo names
  case-insensitively, so the mixed-case pair only looks wrong. The missing `-online` on the three
  PascalCase orgs is the real source of wrong-`owner/repo` guesses.
- **"The platform repo" already means the same thing everywhere.** All 29 orgs have a
  `platform` repo. What differs is **where the storefront lives**. Four orgs keep it in a separate
  repo, and that repo is named three different ways:
  `freeappstore-online/freeappstore`, `freegamestore-online/freegamestore`,
  `proappstore-online/proappstore` and `progamestore-online/storefront`. ProGameStore also has
  two more storefront-ish repos (see the 🔴 finding below). The other orgs keep the storefront
  inside `platform` (e.g. `store/`).
- **Consolidation is mostly already done**, in FAS and FGS on 2026-06-30 (see each repo's
  `PLAN-CONSOLIDATE-PLATFORM.md`). The real remaining sprawl is **product artifacts and test
  fixtures**, not platform tooling. The genuine merges left are small. They are in ProGameStore,
  ProAppStore, FreeWebStore, FreeAgentStore and HeartFull.
- 🔴 **Live hazard found:** `progamestore-online/storefront` and `progamestore-online/marketing`
  both run `wrangler pages deploy … --project-name=progamestore` on push to `main`. That is two
  sources racing to deploy one Cloudflare Pages project. It is the same duplicate-source bug the
  FAS plan describes. A third repo, `progamestore-online/progamestore`, is also a storefront. It
  has no workflow.
- 🔴 **Duplicate Worker source:** `FreeAgentStore/host` and `FreeAgentStore/platform/workers/host`
  both deploy the Worker `freeagentstore-host`.

---

## 1. Inventory

Legend for **Kind**:
- **platform/engine**: SDK, CLI, backend Workers, MCP, console.
- **storefront**: public catalog site.
- **template**: scaffold cloned by a CLI, or a customer-facing design template.
- **website**: marketing site.
- **docs**: knowledge base.
- **product**: one app, game, agent or site that the store publishes.
- **test**: e2e, smoke or spike fixture.
- **other**: anything else.

### 1.1 Orgs

| Org slug (exact) | Domain | Repos (active / archived) | Convention |
|---|---|---|---|
| `ProAgentStore` | proagentstore.online | 15 / 0 | ❌ PascalCase, no `-online` |
| `FreeAgentStore` | freeagentstore.online | 55 / 1 | ❌ PascalCase, no `-online` |
| `FreeDocStore` | freedocstore.online | 3 / 1 | ❌ PascalCase, no `-online` |
| `ProDocStore-online` | prodocstore.online | 2 / 0 | ⚠️ casing only |
| `HeartFull-online` | heartfull.online (product, not a store) | 8 / 0 | ⚠️ casing only |
| `proappstore-online` | proappstore.online | 39 / 3 | ✅ |
| `freeappstore-online` | freeappstore.online | 182 / 14 | ✅ |
| `freegamestore-online` | freegamestore.online | 147 / 175 | ✅ |
| `progamestore-online` | progamestore.online | 14 / 0 | ✅ |
| `freewebstore-online` | freewebstore.online | 33 / 0 | ✅ |
| `prowebstore-online` | prowebstore.online | 6 / 0 | ✅ |
| `freedatastore-online` | freedatastore.online | 12 / 0 | ✅ |
| `freeideastore-online` | freeideastore.online | 1 / 0 | ✅ |
| `proideastore-online` | proideastore.online | 1 / 0 | ✅ |
| `freedesignstore-online` | freedesignstore.online | 1 / 0 | ✅ |
| `free3dstore-online`, `freeadstore-online`, `freebiostore-online`, `freebookstore-online`, `freechipstore-online`, `freecodestore-online`, `freecryptostore-online`, `freemarketingstore-online`, `freemusicstore-online`, `freepeerstore-online`, `freequantumstore-online`, `freerobotstore-online`, `freespacestore-online`, `freewritingstore-online` | `<store>.online` | 1 / 0 each | ✅ |

Related orgs that are **not** stores:
- `OpenFrontierOne` is the ecosystem umbrella. It has 3 repos: `openfrontier`, `openfrontier-docs`
  and `.github`.
- `True-Non-Profit` is a customer.
- `FreeWebStore` (PascalCase) is **a third party** (freewebstore.com, 0 repos) and not ours. Any
  tool that guesses `FreeWebStore/…` for our FreeWebStore will hit a stranger's org. That is the
  strongest argument for standardising on the `-online` suffix.

The slugs `proagentstore-online`, `freeagentstore-online` and `freedocstore-online` are all
**unclaimed** (404 on 2026-10-01). They could be reserved today.

### 1.2 Repos per org (non-product repos in full; products summarised)

#### ProAgentStore (PAGS)
| Repo | Kind | Notes |
|---|---|---|
| `platform` | platform/engine + storefront | This repo. pnpm monorepo: `workers/` (api, host, mcp), `store/`, console, iOS/Android, plugins. 7 deploy/publish workflows. |
| `competitor-intel`, `content-pipeline`, `creator-os-agent`, `data-analyst`, `email-drafter`, `github-browser`, `invoice-parser`, `lead-qualifier`, `meeting-notes`, `qa-automation`, `seo-auditor`, `site-monitor`, `small-business-website-lead-finder`, `support-escalator` | product (agent) | 14 standalone agent repos. The README records "standalone org repo per agent" as deliberate. |

#### proappstore-online (PAS)
| Repo | Kind | Notes |
|---|---|---|
| `platform` | platform/engine | SDK + CLI + backend + Workers (`deploy-admin/backend/host/mcp/kb-host/qa-worker/agent-teams`). |
| `proappstore` | storefront | Static site. Deploys to the Pages project `proappstore`. **Also hosts the reusable `app-ci.yml`** that app repos call (`uses: proappstore-online/proappstore/.github/workflows/app-ci.yml@main`, confirmed in `kanban`). |
| `console` | platform/engine | Creator Console (console.proappstore.online). Separate repo with its own CI. |
| `dashboard` | platform/engine? | "Pro Dashboard". Its README is still the unmodified FAS `template-standalone` text. Last push 2026-07-13. Probably superseded by `console`; needs verification. |
| `template-app` | template | Cloned by `pas create`. Marked as a GitHub template. |
| `admin`, `host`, `mcp` | archived | Already folded into `platform`. |
| `freedocstore-editor` | product, but **another store's** | "Editor and publisher for Zensical knowledge bases". It belongs to the FreeDocStore family but lives in the PAS org. |
| `aipa-console` | other | No description. |
| `testest`, `tt`, `kbqa-smoke`, `codex-mcp-smoke-20260815`, `clean-up` | test | Smoke and test apps. |
| ~25 others (`jobs`, `kanban`, `leads`, `crm`, `stash`, `tradeport`, `chess-academy`, …) | product (app) | One repo per app by design. `bandmates` and `prolang` describe themselves as "⚠️ Inactive". |

#### freeappstore-online (FAS)
| Repo | Kind | Notes |
|---|---|---|
| `platform` | platform/engine | Consolidated 2026-06-30: `workers/{admin,agent,host,mcp,…}`, `sites/{console,create}`, `brand/`, `ops/`. 18 workflows. |
| `freeappstore` | storefront | Static site built from `registry.json`. The admin Worker reads `raw.githubusercontent.com/freeappstore-online/freeappstore/main/registry.json`, and `ops/` docs plus app `CLAUDE.md`s link to it. Deploys every 6 h on cron as well as on push. |
| `template-connected`, `template-standalone` | template | `fas init` clones them **by URL**, so they must stay standalone and public. |
| `ai` (private) | platform/engine | "Shared AI provider package". Not folded into `platform`. |
| `vault` (private, 0 KB) | other | "Infrastructure secrets and deployment credentials". Empty. |
| `admin`, `brand`, `console`, `create`, `host`, `life`, `mcp`, `ops`, `publisher` | archived | Folded into `platform`. |
| ~165 active app repos | product (app) | About 12 are test fixtures: `e2e-canary-mtyb4qk2o7om`, `e2e-fix-check`, `smoke-sandbox`, `mcp-live-demo`, `hello-world`, `hello-world-greetings`, `demo-todo`, `my-todo-app{,-2,-3}`, `my-todos`, `lol-app`. |

#### freegamestore-online (FGS)
| Repo | Kind | Notes |
|---|---|---|
| `platform` (private) | platform/engine | Consolidated. Workers for admin, agent, auth, console, host, leaderboard and mcp. |
| `freegamestore` | storefront | Pages project `freegamestore`. **Hosts the reusable `game-ci.yml`** that every game calls (`uses: freegamestore-online/freegamestore/.github/workflows/game-ci.yml@main`, confirmed in `snake`, `tetris`, `2048` and `minesweeper`). |
| `template-game-{3d,babylon,canvas,cards,excalibur,grid,kaplay,littlejs,phaser,pixi}` | template | 10 engine templates. `template-game-babylon` (74 MB) and `template-game-pixi` (58 MB) are unusually large. |
| `brand` (private) | other | Not folded. |
| `fgs-fork-api-spike-45-20260925` | test (fork) | Its own description says "deleted after verification". It was not deleted. |
| `admin`, `agent`, `auditor`, `auth`, `console`, `host`, `leaderboard`, `mcp`, `console-deprecated` | archived | Folded. |
| 137 archived `e2e-create-*` | test | Archived e2e fixtures. |
| ~133 active game repos | product (game) | Include obvious tests and junk: `mcp-proof`, `mcp-snake-test`, `mcp-hybrid-test`, `ts-probe`, `zombie123`, `zombie123mmymymynmynamynammynamemynamemyname`. There are also near-duplicates such as `a-jungle-race`/`ajungle-race`, `royal-heist`/`royalheist` and `my-dream-room`/`mydream-room`. |

#### progamestore-online (PGS)
| Repo | Kind | Notes |
|---|---|---|
| `platform` | platform/engine | Packages only: games SDK, CLI and compliance. **No Workers.** |
| `admin` (private) | platform/engine | Provisioning Worker. Standalone. |
| `auth` (private) | platform/engine | OAuth Worker. Standalone. |
| `storefront` | storefront | Vendored from FGS on 2026-05-20. Deploys to the Pages project `progamestore`. |
| `marketing` | website | "Coming soon" placeholder. **Also deploys to the Pages project `progamestore`.** 🔴 |
| `progamestore` (private) | storefront | "PGS storefront". A third storefront. No workflow. |
| `template-3d-persistent`, `template-realtime`, `template-turn-based` | template | |
| `checkers`, `chess`, `minecrast`, `pong`, `roblix` | product (game) | |

#### freewebstore-online (FWS)
| Repo | Kind | Notes |
|---|---|---|
| `platform` (private) | platform/engine + storefront | Monorepo: `packages/{agent,api,create,freewebstore,host,mcp,template-generator}`. |
| `admin` (private) | platform/engine | Privileged Worker: template publish and GitHub App. Standalone. |
| `cli` | platform/engine | `@freewebstore/cli`. Its own `publish.yml` and RELEASING.md. |
| `host` (private) | platform/engine | **README: "⚠️ RETIRED 2026-07-29 — must not be redeployed"**, yet still active (not archived), and its `deploy.yml` is still present. |
| 28 × `template-*` | template (product) | Designer-published site templates. The admin Worker creates them as `template-{slug}`. |
| `bright-smile-dental`, `the-daily-grind`, `zen-flow-yoga` | product (demo site) | |

#### FreeAgentStore (FAGS)
| Repo | Kind | Notes |
|---|---|---|
| `platform` | platform/engine + storefront | `workers/{host,mcp}`, `store/`, `console/`, `agents/`. |
| `host` | platform/engine | Worker `freeagentstore-host`. It **duplicates `platform/workers/host`, which deploys the same Worker name.** 🔴 |
| `mcp` | archived | |
| 50 product repos (browser AI tools) | product | Four are **empty**, with no default branch: `browser-rag`, `nano-chat`, `nano-translator`, `text-rewriter`. |

#### FreeDocStore / ProDocStore-online
| Repo | Kind | Notes |
|---|---|---|
| `FreeDocStore/platform` | platform/engine + storefront | Workers, editor, extension and site. |
| `FreeDocStore/freedocstore-docs` | docs | The platform's own KB, published through the platform itself. |
| `FreeDocStore/true-non-profit` | product (customer KB) | |
| `FreeDocStore/mcp` | archived | |
| `ProDocStore-online/platform` | platform/engine + storefront | Its README says the source of truth is now D1 + R2, **not** GitHub. |
| `ProDocStore-online/customer-knowledge-base` (private) | product (KB) | 6 KB. Possibly a leftover from the superseded GitHub-backed model. |

#### prowebstore-online (PWS)
| Repo | Kind | Notes |
|---|---|---|
| `platform` (private) | platform/engine + storefront + docs | Has a `fleet-update.yml`. |
| `template-church`, `template-shop` | template | |
| `lol`, `test-provision`, `test-shop` | product / test | `test-*` are provisioning tests. |

#### HeartFull-online (product org, not a store)
| Repo | Kind | Notes |
|---|---|---|
| `platform` (private) | platform/engine | Flutter app, `admin/`, `functions/` and Firebase. |
| `website` | website | Static, served with a GitHub Pages `CNAME`. Different stack and host from `platform`. |
| `admin` (private, last push 2025-11-03) | platform/engine | **Same Flutter project shape as `platform/admin/`.** Looks like the pre-monorepo copy. |
| `backend` (private, last push 2025-08-08) | platform/engine | JS. Looks superseded by `platform/functions/`. |
| `convo-attention` (private, Python, last push 2025-10-02) | other | |
| `brand` (private), `ops` (private) | other | Assets and runbooks. |
| `.github` | other | Org profile. It still describes the product as "Free Dates". |

#### Single-repo and small orgs
- Each of the 14 one-repo `free*store-online` orgs contains only `platform`. That is already the
  minimum. Several of these `platform` repos are just a static `store/` folder.
- `freedatastore-online` has `platform` plus 11 product repos (browser data tools). None of the tool repos has
  CI workflows.
- `freeideastore-online/platform` and `proideastore-online/platform` each have one repo.

---

## 2. Naming standard (proposed)

### 2.1 Org slug

**`<storename>-online`, all lowercase** (e.g. `proagentstore-online`).

Rationale:
- 24 of 29 orgs already use it.
- It mirrors the domain `<storename>.online`.
- It cannot collide with unrelated PascalCase orgs, as `FreeWebStore` already does.

Non-store product orgs (HeartFull) follow the same rule: `heartfull-online`.

Because GitHub resolves org names case-insensitively, a **case-only** difference never breaks a
call. Fixing one is cosmetic. Tooling should still compare slugs case-insensitively. PAGS already
does this: `workers/api/src/lib/repo-write-scope.ts`, `sameRepo()`.

### 2.2 Repo names

| Role | Canonical name | Rule |
|---|---|---|
| Shippable platform code: SDK, CLI, backend Workers, MCP, console, privileged Workers, brand, ops | `platform` | Exactly one per org. Workers go in `platform/workers/<name>`, sites in `platform/sites/<name>`, packages in `platform/packages/<name>`. No standalone `admin`/`host`/`auth`/`mcp`/`console`/`brand`/`ops` repos. |
| Public catalog at the apex domain | inside `platform` (`store/` or `sites/storefront/`) **by default**. When it must be standalone (§3.2), the repo is named `storefront`. | |
| Marketing site, when separate from the catalog | `website` | |
| Knowledge base about the store itself | `docs` | |
| Scaffold template cloned by a CLI | `template-<kind>` | Already true everywhere. |
| Designer or customer template (product) | `template-<slug>` | FWS. Already true. |
| Published app, game, agent, tool or site | `<kebab-slug>` | No store prefix. One repo each. |
| Org profile | `.github` | |
| Test, e2e or spike fixtures | **not allowed to persist** | Create them in a dedicated sandbox org or delete them on teardown. |

All repo names are lowercase kebab-case. Every existing repo already complies; the only exception
is `.github`, which is fine.

### 2.3 Gap report

| # | Current | Proposed | Severity | Who |
|---|---|---|---|---|
| G1 | org `ProAgentStore` | `proagentstore-online` | High-impact rename (see §4) | 🔴 needs-human (Serge) |
| G2 | org `FreeAgentStore` | `freeagentstore-online` | Medium | 🔴 needs-human (Serge) |
| G3 | org `FreeDocStore` | `freedocstore-online` | Medium. Its README calls `FreeDocStore` "canonical", so that statement changes too. | 🔴 needs-human (Serge) |
| G4 | org `ProDocStore-online` | `prodocstore-online` | Cosmetic (case only) | 🔴 needs-human (Serge) |
| G5 | org `HeartFull-online` | `heartfull-online` | Cosmetic (case only) | 🔴 needs-human (Serge) |
| G6 | `freeappstore-online/freeappstore` | `storefront`, or fold into `platform` | Medium. Admin Worker raw URL, ops docs, app `CLAUDE.md`s. | 🔴 Serge (repo rename) |
| G7 | `freegamestore-online/freegamestore` | `storefront` | **High.** Every game's `deploy.yml` calls `…/freegamestore/.github/workflows/game-ci.yml@main`. | 🔴 Serge |
| G8 | `proappstore-online/proappstore` | `storefront` | High. Every app's `ci.yml` calls `…/proappstore/.github/workflows/app-ci.yml@main`. | 🔴 Serge |
| G9 | `progamestore-online/{storefront,progamestore,marketing}` | one `storefront` (see M1) | High (live deploy race) | 🔴 Serge |
| G10 | `FreeDocStore/freedocstore-docs` | `docs` | Low | 🔴 Serge |
| G11 | `OpenFrontierOne/openfrontier-docs` | `docs` (and `openfrontier` → `website`) | Low | 🔴 Serge |
| G12 | standalone `admin`/`auth`/`host`/`cli`/`console`/`ai`/`brand`/`ops` in PGS, FWS, FAGS, PAS, FAS, FGS, HeartFull | fold into `platform` (see §3) | Varies | per merge |
| G13 | Test fixtures across orgs (137 `e2e-create-*` in FGS, ~12 in FAS, ~6 in FGS active, ~5 in PAS, 2 in PWS, 1 fork in FGS) | delete | Low risk, large count reduction | 🔴 needs-human (Serge): deletions |
| G14 | 4 empty FAGS repos | delete | None | 🔴 needs-human (Serge) |
| G15 | `proappstore-online/freedocstore-editor` | transfer to the FreeDocStore org, or confirm it is a PAS app | Low | 🔴 needs-human (Serge): transfer |

**Recommendation on G6–G8:** do **not** rename existing standalone storefront repos just for the
name. The rename touches every product repo's CI, and reusable-workflow `uses:` references should
not be trusted to follow GitHub's rename redirect. The cost is out of all proportion to a cosmetic
gain. Adopt `storefront` for new stores. Document the three legacy names in the alias table
(§4.4). Rename only alongside a fleet-wide CI update that already touches every product repo.

---

## 3. Consolidation assessment

### 3.1 What must stay split (all stores)

1. **Product repos (apps, games, agents, tools, sites, customer templates).** One repo per
   artifact is the product model. Creators own them, each has its own CI → R2/Pages deploy, and
   `fas`/`fgs`/`pas`/FWS-admin provision them as separate repos. Count reduction here is
   **pruning** (archiving dead artifacts, deleting fixtures), not merging.
2. **CLI-cloned scaffold templates** (`template-*`). The CLIs `git clone` them by URL, so they must
   stay standalone and public.
3. **Storefronts that host a reusable workflow** for product repos: FGS `freegamestore` and PAS
   `proappstore`. Folding one into `platform` would move `uses:` targets for every product repo.
   It would also put the storefront's `registry.json` bot commits and 6-hourly cron deploys into
   the platform repo's history and CI.
4. **Separate privacy or stack boundaries.** These are:
   - FGS `platform` is private while games and storefront are public.
   - HeartFull `website` is a static GitHub Pages site, while `platform` is Flutter + Firebase.

### 3.2 Storefront-as-directory: when it is feasible

It is feasible when the storefront has no reusable workflow consumed by product repos and is not
cloned or read by URL from elsewhere. PAGS, FAGS, FWS, FDS, PDS, PWS, FIS and the single-repo
stores **already** do this. Of the four standalone storefronts:

| Storefront | Fold into platform? | Why |
|---|---|---|
| FAS `freeappstore` | Optional (FAS's own plan says "default: keep separate") | Product apps do not call a reusable workflow from it; the sampled `timer` and `notes` are self-contained. The admin Worker reads `registry.json` by raw URL, and the cron reconcile commits registry back. Feasible. Medium cost. |
| FGS `freegamestore` | No | It hosts `game-ci.yml` for ~133 games. |
| PAS `proappstore` | No | It hosts `app-ci.yml` for the app repos. |
| PGS `storefront` | Yes (as part of M1) | Games don't reference it. It is a vendored copy with no consumers. |

### 3.3 Template sharing across stores

Not recommended. Templates are store-specific because each one imports that store's SDK
(`@freeappstore/*`, `@proappstore/*`, `@freegamestore/*`, `@progamestore/*`). They are also
cloned by each store's CLI from that store's org. Sharing would mean a neutral org plus
parameterised SDK imports, which adds coupling between free and pro tiers that release
independently.

Shared code belongs in **npm packages**. FAS `template-connected` already describes its backend
as "shared with Pro". The duplication that is worth removing is the **vendored storefront**: PGS
`storefront` is a copy of FGS `freegamestore`. That is a later, separate ticket: extract the
storefront builder into a package.

### 3.4 Proposed merges (per store)

| ID | Store | Merge | Reasons for | Blast radius / migration cost | Net repos |
|---|---|---|---|---|---|
| **M1** | PGS | `storefront` + `progamestore` + `marketing` → one storefront in `platform/sites/storefront` (or keep `storefront` standalone) | Three repos for one site. **Two of them deploy to the same Pages project `progamestore`.** No product repo references any of them. | Low. Pages project name and custom domain are account-level and unchanged. Pick the source of truth, then delete the other two workflows before archiving. | −2 or −3 |
| **M2** | PGS | `admin` + `auth` → `platform/workers/{admin,auth}` | Same shape FAS and FGS adopted. One CI and one secret scope. Today `platform` has no Workers at all. | Low/medium. Worker names, routes and secrets live in the CF account. Move `deploy` workflows, and check that org secrets are visible to `platform`. Re-point PAGS bindings if any exist. | −2 |
| **M3** | FAGS | Archive `host` (keep `platform/workers/host`) | Two sources deploy the Worker `freeagentstore-host`. | Low. Disable `host/.github/workflows/deploy.yml` first, then diff `src/` against `platform/workers/host` to confirm no unique changes. | −1 |
| **M4** | FWS | Archive `host` | README says retired and never redeploy, but the repo is active and its deploy workflow still exists. | None. Delete the workflow, then archive. | −1 |
| **M5** | FWS | `admin` → `platform/workers/admin` (optional) | It is the same pattern as FAS/FGS (privileged Worker in `platform/workers/`). | Medium. The GitHub App private key and its secrets must be readable by `platform` (private). The CLI talks to it by URL, which is unchanged. | −1 |
| **M6** | FWS | `cli` → `platform/packages/cli` | The FAS and FGS CLIs already live in `platform/packages`. | Medium. Move the npm publish provenance and trusted publisher config from `cli` to `platform`. A separate release cadence can be kept with a path-filtered `publish.yml`. | −1 |
| **M7** | PAS | `console` → `platform/sites/console`. Archive `dashboard` if `console` supersedes it. | FAS did exactly this on 2026-06-30. `dashboard` README is an unedited template. | Medium. The console deploy target and its secrets move to `platform`. Check PAGS bindings: the PAS Coder instance has `proappstore-online/platform` registered. | −1 to −2 |
| **M8** | FAS | `ai` (private) → `platform/packages/ai`. Delete `vault` (empty). | Leftovers from the June consolidation. | Low. `vault` is 0 KB. Confirm nothing references it before deleting. | −2 |
| **M9** | FGS | `brand` → `platform/brand`. Delete the `fgs-fork-api-spike-45-…` fork. | FAS already folded `brand`. The fork's own description says it should be gone. | None. | −2 |
| **M10** | HeartFull | Archive `admin` and `backend` after confirming `platform/admin` and `platform/functions` supersede them. Fold `ops` (runbooks) into `platform/docs/ops`. | `admin` has the same Flutter project layout as `platform/admin/`, and neither repo has been pushed for ~11 months. | Low. Check Firebase/Codemagic configs for references to the old repos. | −2 to −3 |
| **M11** | FDS/PDS | Rename `freedocstore-docs` → `docs` (G10). Decide on `ProDocStore-online/customer-knowledge-base`. | PDS no longer stores KBs in GitHub. | Low. The Pages project for the docs is account-level. | 0 / −1 |
| **P1** | FGS | Delete 137 archived `e2e-create-*` plus ~6 active test games. Resolve near-duplicate games. | Biggest single source of sprawl. | None for platform. These are test fixtures. Make the e2e create a sandbox org or delete on teardown so they stop accumulating. | −143 |
| **P2** | FAS/PAS/PWS/FAGS | Delete test fixtures (~12 FAS, ~5 PAS, 2 PWS) and the 4 empty FAGS repos. | Same. | None. | −23 |

Kept as-is: PAGS (`platform` plus 14 agent repos), FDS/PDS `platform`, PWS `platform` plus
templates, all single-repo orgs, and every product repo not listed under pruning.

### 3.5 Blast radius checklist: what GitHub's redirect does *not* fix

GitHub redirects web URLs and git remotes for renamed or transferred repos and renamed orgs. The
following still need manual work:

1. **PAGS coding-instance repo bindings.** `coding_repos.github_repo`, `repo_slug` and `web_url`
   are stored at bind time from the machine's `origin`.
   - The write-scope gate (`repo-write-scope.ts`, #676) compares the slug in each engine command
     against the registered slugs. A run that pushes to the *new* name of a renamed repo while
     still registered under the old name is reported as a wrong-org write and **halted**.
   - The deploy watch (`last_deploy_run_id`, migration 0076) and the commit-close watch
     (migration 0153) poll GitHub by the stored slug. They rely on the API redirect, which
     works for renames but not if the old name is later re-created.
   - Action: `coding_repo_remove` + `coding_repo_add` per affected instance, or a one-off SQL
     update of all three columns.
2. **Reusable workflows** (`uses: org/repo/.github/workflows/x.yml@main`) in every product repo
   (FGS games, PAS apps). Update them explicitly. Do not rely on the redirect.
3. **Raw URLs** (`raw.githubusercontent.com/<org>/<repo>/…`), e.g. the FAS admin Worker's
   registry URL. Update them in code.
4. **`git clone` URLs inside CLIs** (`fas init`, `pas create`, `fgs`). The redirect works for
   clone, but published CLI versions keep the old URL forever. The old slug must therefore
   **never be re-created**, or old CLIs will clone the wrong thing.
5. **wrangler configs and Cloudflare.** Worker and Pages names are account-level and unaffected by
   GitHub renames. However, Pages projects with a **GitHub integration** (not `wrangler pages
   deploy`) are bound to the repo and must be reconnected.
6. **Org rename only:**
   - The GitHub App installation survives, but app config that lists orgs by name needs updating.
   - The **MCP registry namespace** changes: `server.json` publishes as
     `io.github.ProAgentStore/platform`, so a rename needs a new registry entry plus a
     deprecation of the old one.
   - Plugin marketplace manifests change: `.claude-plugin/marketplace.json` and
     `plugins/*/plugin.json`.
   - Codemagic and other CI integrations change.
   - npm `repository` fields change.
   - Org-level secrets and variables survive.
   - **The old org name becomes claimable by anyone** once it is released.
7. **Hardcoded URLs in this repo.** 43 tracked files contain `github.com/ProAgentStore`, and code
   comments and tests cite slugs. These are mostly harmless once the redirect is in place, but
   doc links should be updated.
8. **Agent prompts, memories and knowledge.** Instance instructions, operator manuals and memory
   entries that name `owner/repo` are free text. Grep them before and after each rename.

---

## 4. Recommended end-state and migration checklists

### 4.1 End-state (per store)

```
<store>-online/
├── platform            # everything the store runs: packages/, workers/, sites/, store/, docs/, brand/
├── storefront          # ONLY where product repos call its reusable workflow (FGS, PAS; legacy names kept)
├── website             # ONLY where the marketing site is a different stack/host (HeartFull)
├── docs                # ONLY where the KB is itself a published product of the store (FDS)
├── template-<kind>     # CLI-cloned scaffolds
└── <product-slug>…     # apps / games / agents / tools / sites — one each, no fixtures
```

Approximate effect: about 727 → about 545 repos (about −180). Almost all of the reduction comes from
fixture pruning (P1/P2). The platform-tooling merges (M1–M10) remove about 15 repos. More
importantly, they remove the two live duplicate-deploy hazards (PGS Pages, FAGS host).

### 4.2 Priority order

1. **M1 and M3 first.** These are live duplicate-deploy hazards. M1 is the most urgent: at least
   disable the deploy workflow in either `marketing` or `storefront` now.
2. **M4, M8, M9, P2.** Zero-risk cleanups.
3. **P1.** Also change the e2e flow so fixtures stop accumulating.
4. **M2, M7, M10, M5, M6.** Real merges. One ticket each.
5. **Org renames G1–G5.** Last, and only if Serge wants them (see §4.4 for the cheaper
   alternative).

### 4.3 Checklist templates

**Folding repo `X` into `platform/<dir>/X`** (M2, M5–M10):
- [ ] Diff `X` against any existing copy in `platform` and resolve unique commits.
- [ ] Copy the source to `platform/<dir>/X`. Exclude it from root lint/workspace if it is a
      self-contained project, as FAS did with `!workers`.
- [ ] Add `deploy-X.yml` (or `publish-X.yml`) to `platform`, path-filtered and
      **dispatch-only** at first.
- [ ] Confirm that org secrets and variables are visible to `platform`. FAS found its R2 creds
      were org-level.
- [ ] Do a dispatch run, and live-check the Worker/site/package.
- [ ] Enable push triggers in `platform`.
- [ ] **Delete the deploy workflow in `X`**, so there is only one source.
- [ ] Update references: PAGS `coding_repos` rows, README/ops links, raw URLs, CLI clone URLs and
      npm `repository` fields.
- [ ] 🔴 needs-human (Serge): archive `X`. Do not delete it, because archived repos keep the
      redirect target and history.

**Merging duplicate storefronts (M1):**
- [ ] Decide the source of truth. The likely choice is `storefront`, which has a full catalog
      build; `marketing` is a placeholder and `progamestore` has no CI.
- [ ] Delete `.github/workflows/deploy.yml` in the non-canonical repos **immediately**.
- [ ] Port anything unique (e.g. `progamestore`'s `_headers`, `card-styles.css`) into the
      canonical one.
- [ ] Optionally move the canonical one into `progamestore-online/platform/sites/storefront`.
- [ ] Re-point PAGS bindings if any exist.
- [ ] 🔴 needs-human (Serge): archive the others.

**Renaming a repo (G6–G11):**
- [ ] Search every org for the old slug: `gh search code` (incomplete index) **plus** a scripted
      `gh api …/contents/.github/workflows` sweep over all repos in the org.
- [ ] Update reusable-workflow `uses:` in every consumer **before** the rename, using a fleet
      update PR or commit per repo.
- [ ] Update raw URLs, CLI clone URLs (and release new CLI versions) and Pages GitHub
      integrations.
- [ ] 🔴 needs-human (Serge): rename.
- [ ] Update PAGS `coding_repos` rows. Run a deploy-watch tick and confirm it resolves.
- [ ] Never re-create the old name.

**Renaming an org (G1–G5):**
- [ ] Reserve the new slug if needed. Note: you cannot reserve by creating an org and then
      rename onto it; free the name first.
- [ ] Inventory everything in §3.5 item 6 for that org.
- [ ] 🔴 needs-human (Serge): rename in org settings. GitHub warns that the old name becomes
      available to others.
- [ ] Immediately create a placeholder org under the old name to block squatting. This requires
      the name to be released first; GitHub may hold it briefly.
- [ ] For PAGS specifically:
  - Re-publish the MCP registry entry under the new namespace.
  - Update `server.json`, the plugin manifests, `package.json` `repository`, Codemagic, the
    `pags-dev` agent definition, AGENTS.md/CLAUDE.md and every `coding_repos` row naming
    `ProAgentStore/*`.
  - Update the GitHub App's configured org list.
- [ ] Run the full CI and a coding run against the renamed repo to confirm the write-scope gate
      does not halt.

### 4.4 Cheaper alternative to org renames (recommended first step)

Before any org rename, publish a **canonical alias table** in one place that both tools and agents
read. Candidates are `platform_guide` / the operator manual and this doc. The table maps each store
to its exact org slug and its platform/storefront repo slugs:

| Store | Org | Platform repo | Storefront repo |
|---|---|---|---|
| PAGS | `ProAgentStore` | `ProAgentStore/platform` | (in platform: `store/`) |
| PAS | `proappstore-online` | `proappstore-online/platform` | `proappstore-online/proappstore` |
| FAS | `freeappstore-online` | `freeappstore-online/platform` | `freeappstore-online/freeappstore` |
| FGS | `freegamestore-online` | `freegamestore-online/platform` | `freegamestore-online/freegamestore` |
| PGS | `progamestore-online` | `progamestore-online/platform` | `progamestore-online/storefront` (after M1) |
| FWS | `freewebstore-online` | `freewebstore-online/platform` | (in platform) |
| PWS | `prowebstore-online` | `prowebstore-online/platform` | (in platform) |
| FAGS | `FreeAgentStore` | `FreeAgentStore/platform` | (in platform: `store/`) |
| FDS | `FreeDocStore` | `FreeDocStore/platform` | (in platform: `site/`) |
| PDS | `ProDocStore-online` | `ProDocStore-online/platform` | (in platform: `site/`) |
| FIS / PIS | `freeideastore-online` / `proideastore-online` | `…/platform` | (in platform: `store/`) |
| HeartFull | `HeartFull-online` | `HeartFull-online/platform` | `HeartFull-online/website` |
| others | `free<x>store-online` | `free<x>store-online/platform` | (in platform) |

This fixes the reported failure, which is guessing the wrong `owner/repo`, at near-zero cost. It
leaves G1–G3 as an optional cosmetic decision.

---

## 5. Open questions for Serge

1. **Org renames:** rename `ProAgentStore`, `FreeAgentStore` and `FreeDocStore` to
   `<store>-online`, or keep them and rely on the alias table? *Default: alias table now; defer
   renames.* PAGS has the largest blast radius (MCP registry namespace, plugins, bindings).
2. **Reserve the slugs?** Should someone create placeholder orgs for `proagentstore-online`,
   `freeagentstore-online` and `freedocstore-online` now, so they can't be taken? *Default: yes.*
3. **Legacy storefront names** (`freeappstore`, `freegamestore`, `proappstore`): keep them?
   *Default: keep, and only rename alongside a fleet CI update.*
4. **PGS storefront:** which of `storefront`, `progamestore` and `marketing` is the intended live
   site? *Default: `storefront`. Disable the `marketing` deploy now.*
5. **Fixture deletion:** approve deleting the 137 archived `e2e-create-*` repos and the listed test
   repos? Deletion needs org-owner rights. *Default: yes for `e2e-*`/`*-test`/`*-probe`/`*-proof`.
   Archive (do not delete) anything ambiguous.*
6. **Cross-store misplacements:** should `proappstore-online/freedocstore-editor` move to the
   FreeDocStore org? Is `proappstore-online/dashboard` dead? *Default: transfer the first; archive
   the second after confirming `console` covers it.*

Closes #900
