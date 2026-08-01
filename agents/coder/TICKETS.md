# Coder Agent — Feature Tickets

Two features, decomposed into backend-first / frontend tickets so they can be
worked in dependency order. IDs are `CODER-00N`.

Grounding (current code):
- **Deployment/build data** exists today only as the *latest* GitHub Actions run
  per repo: `GET /v1/instances/:id/coding/repos/:repoId/deployment`
  (`workers/api/src/routes/coding.ts:410`). It calls the GitHub API with
  `actions/runs?per_page=1` and returns `{ available, run }` where `run` is
  `{ status, conclusion, name, runNumber, url, branch, sha, updatedAt }` or `null`.
  Returns `{ available:false }` for local repos, non-GitHub repos, or when the
  GitHub App isn't installed.
- **Agent run status** exists today only as a per-session live poll:
  `GET …/coding/sessions/:sid/capture` returns `{ pane, runState, runnerConnected }`
  where `runState ∈ {idle, thinking, working}`. `CodingTab.tsx` polls this every 3s
  for active sessions into `repoStatuses[repoId]` and tracks `runnerOnline`.
  `ReposList.tsx` already renders a per-repo spinner from that state. There is **no**
  persisted status field on `CodingSession` (`types.ts`: `status ∈ active|suspended|ended`,
  which is lifecycle, not busy/idle).

---

## Feature 1 — Build Status Panel

### CODER-001 — Extend deployment endpoint to return a list of runs (build history) + pagination
**Type:** Backend

**Description**
The Build Status Panel needs *all* recent builds, not just the latest. The current
endpoint hard-codes `per_page=1` and returns a single `run`. Add a sibling that
returns a paginated list of runs so the panel can render build history per repo.

**Acceptance Criteria**
- New route `GET /v1/instances/:id/coding/repos/:repoId/deployments` (plural) returns
  `{ available: boolean, runs: Run[], nextPage?: number }`.
- `Run` shape reuses the existing single-run shape (`status`, `conclusion`, `name`,
  `runNumber`, `url`, `branch`, `sha`, `updatedAt`) — no new fields invented.
- Query params `?page=<n>&perPage=<n>` (default `page=1`, `perPage=20`, clamp `perPage ≤ 50`).
- Same graceful-degradation contract as today: `{ available:false }` (never a 500) for
  local repos, non-GitHub repos, or GitHub App not installed.
- Owner-scoped exactly like the existing route (`requireOwned` + `getRepo`).
- Existing singular `/deployment` route is left untouched (back-compat).

**Technical Notes**
- File: `workers/api/src/routes/coding.ts` — clone the `/deployment` handler
  (~line 410) into a `/deployments` handler; swap `per_page=1` for the paged query and
  map `data.workflow_runs` (array) instead of `[0]`.
- GitHub Actions pagination is via `?per_page=&page=`; surface `nextPage` only when the
  returned count equals `perPage` (cheap "there may be more" signal — avoid parsing the
  `Link` header unless needed).
- **Decision — no new storage yet.** GitHub is the source of truth and already retains
  run history; a DO/KV cache is out of scope here (see CODER-002).

**Dependencies:** none.

---

### CODER-002 — (Optional) Persist build history in KV so it survives GitHub retention + covers non-GitHub repos
**Type:** Backend

**Description**
GitHub Actions history is retention-limited and unavailable for local/non-GitHub repos.
If we want a durable, repo-agnostic build record (e.g. builds triggered by the runner,
or history beyond GitHub's window), persist a compact per-repo build log.

**Acceptance Criteria**
- A build record is written on each observed run transition (queued→in_progress→completed)
  keyed by `instanceId:repoId`, capped to the most recent N (e.g. 50) entries.
- `/deployments` (CODER-001) merges persisted history with live GitHub data, de-duped by
  `runNumber`/`url`, without breaking the `{ available:false }` contract.
- Writes are best-effort: a storage failure never fails the read path.

**Technical Notes**
- **Storage choice:** KV (`env` binding) for a simple append-capped list is sufficient and
  cheapest; a Durable Object is only warranted if we later need per-repo serialized writes
  or real-time fan-out. Recommend **KV now**, revisit DO if CODER-007 lands.
- This is an *enhancement*, not required for a first shippable panel. Ship CODER-001 +
  CODER-004 first; pull this in only if durable/local-repo history is actually needed.

**Dependencies:** CODER-001.

---

### CODER-003 — (Optional) Aggregate builds endpoint across all repos (one call)
**Type:** Backend

**Description**
The panel lists builds for *all* repos in an instance. Rather than the frontend making
one `/deployments` call per repo (N calls, N GitHub round-trips), provide a single
aggregate endpoint.

**Acceptance Criteria**
- `GET /v1/instances/:id/coding/builds` returns
  `{ builds: Array<{ repoId, repoName, available, run: Run | null }> }` — the *latest*
  run per repo (drill-down to full history stays on the per-repo `/deployments`).
- Fans out to GitHub with bounded concurrency; a single repo failing degrades to
  `available:false` for that repo, never fails the whole response.
- Owner-scoped; only repos with a `githubRepo` are queried.

**Technical Notes**
- File: `workers/api/src/routes/coding.ts`. Reuse the per-repo GitHub fetch helper from
  CODER-001; `Promise.allSettled` over the instance's repos.
- **Trade-off:** simplest frontend (1 call) vs. an extra endpoint. If CODER-004 ships
  against per-repo calls first, this is a pure latency optimization — keep it optional.

**Dependencies:** CODER-001.

---

### CODER-004 — Build Status Panel UI (Builds tab/panel in the Coder web surface)
**Type:** Frontend

**Description**
Add a "Builds" view to the Coder agent UI showing every repo's build status. Each entry:
repo/build name + run number, a status badge (**✓ success / ✗ failed / ⟳ running / pending**),
timestamp, and a one-line summary (`branch@sha · workflow`), with a "View run" link.

**Acceptance Criteria**
- A "Repos | Builds" segmented toggle on the all-repos landing view (mirrors the existing
  "Co-pilot | Terminal" toggle style) switches between `ReposList` and the new Builds panel.
- Each build row shows: name/`#runNumber`, status badge, relative timestamp, `branch@sha` summary.
- Status derived from `status` + `conclusion`: `in_progress→running`, `queued→pending`,
  `completed+success→success`, `completed+{failure,cancelled,timed_out}→failed`, else `unknown`.
- Repos that return `available:false` render a muted "not available (local repo / GitHub App
  not installed)" row rather than being hidden silently.
- Empty state when the instance has no GitHub-connected repos.
- Polls for freshness (~20s) while the Builds view is open; stops when not visible.
- **Scrollable on mobile**: scroll container uses `overflow-y-auto overscroll-contain`
  and a bounded height (`flex-1 min-h-0`; use `dvh` if a fixed/overlay layout is introduced),
  consistent with the modal scroll fixes already applied.

**Technical Notes**
- New file: `agents/coder/web/src/BuildsPanel.tsx`. Wire to CODER-001 `/deployments`
  (or CODER-003 `/builds` aggregate if available). Reuse `api` from
  `@proagentstore/sdk/client` and `usePolling` from `@proagentstore/sdk/hooks`.
- Edit `agents/coder/web/src/CodingTab.tsx`: add a `landingView: "repos" | "builds"` state,
  wrap the landing return in the flex-col height container (mirror the session-open branch),
  render the toggle + conditional body.
- Follow `ReposList.tsx` card styling (`bg-paper border border-line rounded-lg p-3`) and the
  project's `lucide-react` icon convention. No new shared types needed beyond a local
  `DeploymentRun`/`Build` interface (or promote to `types.ts` if reused).

**Dependencies:** CODER-001 (hard). CODER-003 optional (latency only).

---

## Feature 2 — Agent "Working" Indicator

### CODER-005 — Working / Idle / Error status indicator in the header/switcher
**Type:** Frontend

**Description**
When a session is open and when switching between repos ("agents"), show a clear status
badge — **Working** (animated spinner), **Idle**, or **Error** — reflecting the current
agent state, in the session header next to the repo switcher.

**Acceptance Criteria**
- Badge in the `onHeaderOverride` header shows: **Working** (spinner, when `runState ∈
  {thinking, working}`), **Error** (when the session/runner is `offline`/disconnected),
  **Idle** otherwise.
- Badge reflects the *currently open* repo and updates live as status changes (not a stale
  snapshot) — i.e. the derived status value is added to the header effect's dependencies.
- The existing repo-switcher dropdown continues to show a per-repo "working" hint (already
  present); no regression there.
- Compact on mobile (icon/short label; fits the 48px header).

**Technical Notes**
- File: `agents/coder/web/src/CodingTab.tsx`. Data already exists — derive from
  `repoStatuses[openSession.repoId]` (from the 3s `/capture` poll) and `runnerOnline`; no new
  API call. Compute a primitive `openStatus` string and add it to the header effect deps
  (deps currently `[openSession, onHeaderOverride, openRepo?.name, view, repoMenuOpen,
  sessionMenuOpen]`) so the header re-pushes only when status actually changes (avoid the
  documented render-storm by depending on the derived string, not the `repoStatuses` object).
- Small presentational `AgentStatusBadge` component (module-scope, like `Detail` in
  `RepoSettingsModal.tsx`).
- **No backend change required** for the first version.

**Dependencies:** none.

---

### CODER-006 — (Optional) Aggregate live session-status endpoint (one call for all sessions)
**Type:** Backend

**Description**
Today the frontend polls `/capture` once per active session to learn each agent's
busy/idle state. For a multi-repo "which agents are working" overview, provide a single
lightweight status endpoint so the count of network calls doesn't scale with session count.

**Acceptance Criteria**
- `GET /v1/instances/:id/coding/status` returns
  `{ runnerConnected: boolean, sessions: Array<{ sessionId, repoId, runState, runnerConnected }> }`.
- Returns quickly without dumping full terminal panes (status only — cheaper than `/capture`).
- Owner-scoped; reflects only the caller's sessions.

**Technical Notes**
- File: `workers/api/src/routes/coding.ts`. Reuse the runtime/relay status plumbing that
  `/capture` already uses, minus the pane payload. Frontend then replaces its per-session
  `/capture` status fan-out (in `CodingTab.pollStatuses`) with this one call.
- **Trade-off:** current per-session polling already works and is simple; this is an
  optimization for many concurrent sessions. Defer unless session counts grow.

**Dependencies:** none (enhances CODER-005).

---

### CODER-007 — (Stretch) Real-time status push instead of polling (Durable Object / relay)
**Type:** Backend

**Description**
Replace status polling with server-pushed updates so Working/Idle/Error and build-state
transitions appear instantly and cheaply, using the existing WebSocket relay infrastructure.

**Acceptance Criteria**
- The runner's existing status transitions are pushed to the console over the existing
  relay/WebSocket path (no new public inbound server).
- Frontend subscribes and updates the header badge (CODER-005) and Builds panel (CODER-004)
  from pushed events, falling back to polling if the socket drops.
- No regression to the relay-token security model (relay token only, never the account JWT).

**Technical Notes**
- Builds on the existing `RelayDO` / relay-token handshake (see platform docs). This is a
  meaningful architecture change — only justified once polling proves insufficient.
- Would supersede CODER-006's polling optimization for status (build history still reads
  from GitHub / CODER-002).

**Dependencies:** CODER-006 (shape of the status event), CODER-005 (consumer UI).

---

## Suggested order

1. **CODER-001** (backend: list endpoint) → **CODER-004** (frontend: Builds panel). Ships Feature 1.
2. **CODER-005** (frontend: Working indicator, uses existing state). Ships Feature 2 with no backend work.
3. Optional/enhancement, as need proves out: **CODER-003** (aggregate builds), **CODER-002**
   (durable build history), **CODER-006** (aggregate status), **CODER-007** (real-time push).
