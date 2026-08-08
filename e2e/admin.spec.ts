import { type Page, expect, test } from "@playwright/test";

/**
 * Admin e2e (#283) — deliberately THREE tests.
 *
 * `store/admin` owns the irreversible cross-tenant levers (suspend, unpublish, delete,
 * cancel, roles, key revoke) and had no end-to-end coverage at all. #280 has since put
 * every guard into pure modules with ~60 unit tests, so this file covers only what a
 * pure test structurally cannot: that the guards are actually WIRED to the controls, and
 * that what leaves over the network matches what the reducer decided.
 *
 * Each test is justified individually rather than generated to fill a checklist —
 * Playwright is the heaviest thing in this repo (#253, #274). What is deliberately NOT
 * here, and why:
 *   - self-targeting refusal: a pure guard plus a plain conditional render (unit-tested)
 *   - the audit trail refreshing: low consequence, and the refresh signal is unit-visible
 *   - roles / cancel / unsuspend: identical DangerAction wiring to the delete below;
 *     re-driving it per page buys repetition, not coverage
 *
 * ── Isolation ──
 * Nothing here mutates anything. Every API call is intercepted with `page.route` against
 * a URL that is never reached, so there are no fixtures to seed or tear down and the
 * spec CANNOT be pointed at production — there is no code path in it that performs a
 * real request. The session token is a literal written into localStorage.
 *
 * That also answers the `requireAdmin` / #108 question: the spec never authenticates.
 * `/v1/admin/me` is mocked to `{admin:true}`. Server-side authorization is a server
 * concern with its own tests; weakening the real perimeter so a browser test could pass
 * through it would trade the thing being protected for coverage of the thing protecting it.
 */

const API = "https://api.proagentstore.online";
const TEST_TOKEN = "test-pags-admin-token";

type Json = Record<string, unknown>;

interface AdminMock {
	/** Recorded request bodies, in order, for whatever route the test cares about. */
	requests: Array<{ method: string; path: string; body: Json | null }>;
	/** Status/body to answer the agent DELETE with; consumed one per call. */
	deleteResponses: Array<{ status: number; body: Json }>;
}

const AGENT = {
	id: "agent-1",
	slug: "lead-finder",
	name: "Lead Finder",
	category: "sales",
	model: "claude-sonnet-4-6",
	visibility: "published",
	status: "active",
	created_at: "2026-07-01T00:00:00Z",
	owner_id: "user-2",
	owner_login: "creator-two",
	instances: 3,
	connectors: [],
};

async function mockAdmin(page: Page, instances: Json[] = []): Promise<AdminMock> {
	await page.addInitScript((token) => {
		window.localStorage.setItem("pags:session", token);
	}, TEST_TOKEN);

	const mock: AdminMock = { requests: [], deleteResponses: [] };

	await page.route(`${API}/**`, async (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname;
		const method = route.request().method();
		const json = (data: unknown, status = 200) =>
			route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });

		if (method !== "GET") {
			let body: Json | null = null;
			try {
				body = route.request().postDataJSON() as Json;
			} catch {
				body = null;
			}
			mock.requests.push({ method, path, body });
		}

		if (path === "/v1/admin/me") return json({ admin: true });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "operator" });
		if (path === "/v1/admin/audit") return json({ audit: [] });

		if (path === `/v1/admin/agents/${AGENT.slug}` && method === "GET") {
			return json({
				agent: AGENT,
				capabilities: { surfaces: [], runtime: null, workflow: null, tools: [] },
				connectorTools: [],
				instances: [],
				subscribers: { total: 5, active: 3 },
				recentActivity: [],
			});
		}

		if (path === `/v1/admin/agents/${AGENT.id}` && method === "DELETE") {
			const next = mock.deleteResponses.shift() ?? { status: 200, body: { canceledInstances: 0 } };
			return json(next.body, next.status);
		}

		if (path === "/v1/admin/instances" && method === "GET") {
			return json({ instances, total: instances.length });
		}

		return json({});
	});

	return mock;
}

/** The delete panel on the agent's moderation card. */
function openDelete(page: Page) {
	return page.getByRole("button", { name: "Delete agent" }).click();
}

test.describe("admin destructive controls", () => {
	test("nothing destructive fires on one click — the echo gate has to be satisfied first", async ({ page }) => {
		// Justification: #280 tests the reducer, but only a browser can show that the gate
		// is actually CONNECTED — that DangerAction is mounted, that `disabled` is bound to
		// it, and that the confirm sends the phrase the operator typed rather than the slug
		// the page already had in props. A gate that is correct and unwired is no gate.
		const mock = await mockAdmin(page);
		await page.goto(`/admin/agents/${AGENT.slug}`);

		await expect(page.getByRole("heading", { name: /Lead Finder/ })).toBeVisible();

		// The button alone destroys nothing: it opens a panel.
		await openDelete(page);
		const confirm = page.getByRole("button", { name: "Confirm" });
		await expect(confirm).toBeDisabled();
		expect(mock.requests.filter((r) => r.method === "DELETE")).toHaveLength(0);

		// A near-miss must not arm it.
		const echo = page.getByTestId("danger-echo");
		await echo.fill("lead-finde");
		await expect(confirm).toBeDisabled();

		await echo.fill(AGENT.slug);
		await expect(confirm).toBeEnabled();
		await confirm.click();

		const deletes = mock.requests.filter((r) => r.method === "DELETE");
		expect(deletes).toHaveLength(1);
		expect(deletes[0].body).toMatchObject({ confirm: AGENT.slug, force: false });
	});

	test("a 409 shows the live-subscriber count, and forcing is a SECOND, distinct action", async ({ page }) => {
		// Justification: this is the highest-consequence regression in the app — a silent
		// force-delete strands live subscribers with no one having read the count. The unit
		// tests prove `force` is derived from the recorded 409; only this test proves that
		// what actually went over the wire on attempt one carried no force.
		const mock = await mockAdmin(page);
		mock.deleteResponses.push({ status: 409, body: { error: "Agent has 3 active instances" } });
		mock.deleteResponses.push({ status: 200, body: { canceledInstances: 3 } });

		await page.goto(`/admin/agents/${AGENT.slug}`);
		await openDelete(page);
		await page.getByTestId("danger-echo").fill(AGENT.slug);
		await page.getByRole("button", { name: "Confirm" }).click();

		// The count leads the copy, and it is the platform's number, not a guess.
		await expect(page.getByText(/3 live subscriber instance/i)).toBeVisible();

		// Forcing is its own button, labelled with what it will do — not the same Confirm
		// quietly changing meaning underneath the cursor.
		const force = page.getByRole("button", { name: /Cancel 3 subscriber\(s\) & delete/ });
		await expect(force).toBeVisible();

		const first = mock.requests.filter((r) => r.method === "DELETE")[0];
		expect(first.body).toMatchObject({ force: false });

		await force.click();
		const deletes = mock.requests.filter((r) => r.method === "DELETE");
		expect(deletes).toHaveLength(2);
		expect(deletes[1].body).toMatchObject({ confirm: AGENT.slug, force: true });
	});

	test("the instances list renders all FOUR runtime states, and 'unknown' never reads as offline", async ({ page }) => {
		// Justification: #280 calls this the worst failure in the app — an operator who
		// reads "offline" for a machine nobody checked kills a healthy runner. The
		// derivation and the wording are unit-tested; this proves the four states survive
		// all the way onto the screen as four different things.
		// Agent names are deliberately meaningless (Alpha/Bravo/…) rather than descriptive:
		// naming a row "Live" makes the row text match the status text, and the assertion
		// passes on the name instead of on the thing being tested.
		const base = { user_id: "user-2", owner_login: "creator-two", status: "active", created_at: "2026-07-01", last_seen_at: null };
		await mockAdmin(page, [
			{ ...base, id: "i-alpha", agent_name: "Alpha", runtime_nodes: 1, runtimeConnected: true },
			{ ...base, id: "i-bravo", agent_name: "Bravo", runtime_nodes: 1, runtimeConnected: false },
			{ ...base, id: "i-charlie", agent_name: "Charlie", runtime_nodes: 1, runtimeConnected: null },
			{ ...base, id: "i-delta", agent_name: "Delta", runtime_nodes: 0, runtimeConnected: null },
		]);

		await page.goto("/admin/instances");
		await expect(page.getByRole("heading", { name: "Instances" })).toBeVisible();

		const row = (name: string) => page.getByRole("row").filter({ hasText: name });
		await expect(row("Alpha").getByText("live")).toBeVisible();
		await expect(row("Bravo").getByText("offline")).toBeVisible();
		await expect(row("Charlie").getByText("unknown")).toBeVisible();
		await expect(row("Delta").getByText("no runner")).toBeVisible();

		// The distinction is the whole point: the unchecked row must not claim the machine
		// is down, and the never-registered one must not invent a machine that is.
		await expect(row("Charlie").getByText("offline")).toHaveCount(0);
		await expect(row("Delta").getByText("offline")).toHaveCount(0);
	});
});

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * mobile — the operator portal's <select> controls, contained (#414, porting #384)
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * WHY THIS BLOCK EXISTS AT ALL, which is the more important half. Before it, this file had one
 * `describe` and no name beginning `mobile — `. `playwright.config.ts` scopes the WebKit project
 * with `grep: /mobile — /`, so the operator portal was **Chromium-only in CI with no geometry
 * assertion of any kind**. That is the exact shape of #333: a guard that runs one engine cannot
 * see the class of defect that only exists in the other, however thorough it is otherwise. The
 * `mobile — ` prefix on every test below is therefore load-bearing, not decoration — delete it
 * and these silently stop running in the only engine that can fail them.
 *
 * THE DEFECT. WebKit's menulist lays its content out at the width of the WIDEST OPTION, not of
 * the selected one, and that box counts toward every ancestor's layout overflow. `store/admin`
 * had no containment on any of its 16 selects, and its exposure is worse than the console's: all
 * 16 are `!w-auto`, sized by their own content rather than capped at `width: 100%` by a
 * container, and three are populated at runtime from server data.
 *
 * ── READ THIS BEFORE TRUSTING A LOCAL RUN ──
 *
 * macOS WebKit is green with OR without the fix. #384 established that over twelve red commits,
 * and #414 re-confirmed it by disabling the console's shipped `contain: paint` at runtime and
 * still measuring 0. **Linux WebKit — what CI runs — is the only place this is visible**, where
 * the equivalent console page measured 68px at 320px. So a green run on a Mac is not evidence
 * that this rule works; it is evidence that these tests do not crash. CI is the instrument.
 *
 * ── What is asserted, and why it is the SELECT and not the page ──
 *
 * Per select, on every route: (a) its own box does not reach past the viewport, and (b) it does
 * not widen the row it sits in, ATTRIBUTED by taking the control out of flow and re-measuring.
 * #384 spent twelve commits proving (b) is the necessary one: the page-level signature of this
 * defect is `mainOv = 68` with NOTHING's box past the right edge, because what escapes is the
 * option list inside a native control and has no element of its own to measure. A page-level
 * number alone names nobody, which is why #414 asked for the attribution specifically.
 *
 * `<main>`'s own overflow is deliberately NOT asserted here, and that is a scope decision with a
 * measurement behind it rather than an omission. Running it found real page-level overflow on two
 * routes, in **Chromium**, with **zero** select offenders — so it is a different defect:
 *
 *     /admin/errors        mainOv 344px @320, 274px @390   `table.w-full.text-sm` lays out at
 *                                                          664px; the signature cell is
 *                                                          `max-w-[420px]` and the source cell
 *                                                          `whitespace-nowrap`, inside a `Panel`
 *                                                          that is not a scroller. Data-independent:
 *                                                          a 420px cell cannot fit a 320px phone.
 *     /admin/github-issues mainOv 8px @320 (0 @390)        a Stat card in the `grid-cols-2` header.
 *
 * Neither is a `<select>`, neither is fixed by `contain: paint`, and fixing them means re-laying
 * out the operator portal's data tables — separable work that needs its own ticket and its own
 * measurement. Asserting it in THIS block would have made #414's guard permanently red on
 * somebody else's defect, which is the fastest way to get a guard deleted.
 *
 * ── Widths: 320 and 390, and why not the four #414 asked for ──
 *
 * #384's own Linux-WebKit measurements were monotonic in width — 68px at 320, 28 at 360, 13 at
 * 375 — so 320 dominates 360 and 375 and the extra runs buy repetition. 390 is kept because it
 * is NOT dominated: it is the width where `<main>` absorbs overflow that the page-level number
 * reports as 0, which is precisely the case the per-select attribution catches and the page-level
 * check does not. The 1.3x text-scale leg from #414's acceptance is not applicable here and was
 * checked rather than skipped: `pags:textScale` is a console mechanism (`store/console/src/main.tsx`)
 * and the string appears nowhere in `store/admin`.
 */

/** Real source values from this platform's own trace/error vocabulary — see pags/CLAUDE.md. */
const ERROR_SOURCES = ["client:voice-tts", "client:voice-audio", "workflow:coding-session", "workflow:job-apply", "worker:api"];

/**
 * Real label names off `ProAgentStore/platform`, counts included because that is what the
 * control renders (`{l.name} ({l.total})`). `deferred: no demand` is the longest label the repo
 * actually has, and a fixture of short invented names would make this whole block vacuous — the
 * hollow-fixture failure `e2e/console.spec.ts` has already shipped twice.
 */
const REPO_LABELS = [
	{ name: "deferred: no demand", total: 12, open: 12, closed: 0 },
	{ name: "good first issue", total: 8, open: 3, closed: 5 },
	{ name: "deferred-by-#68", total: 6, open: 6, closed: 0 },
	{ name: "browser-agents", total: 4, open: 1, closed: 3 },
	{ name: "admin-portal", total: 3, open: 2, closed: 1 },
];

/**
 * Every read endpoint the select-bearing routes need, answered with content.
 *
 * Deliberately separate from `mockAdmin` above: that one exists to record MUTATIONS and its
 * empty lists are the right fixture for it. This one exists to PAINT, and #414's own attempt at
 * this measurement covered 9 of the 16 selects because its fixture left five routes on
 * `<Loading />` — every page here early-returns before its filter bar when its data is null.
 */
async function mockAdminSurfaces(page: Page) {
	await page.addInitScript((token) => {
		window.localStorage.setItem("pags:session", token);
	}, TEST_TOKEN);

	const agents = Array.from({ length: 6 }, (_, i) => ({
		...AGENT,
		id: `agent-${i}`,
		slug: `agent-${i}`,
		name: `Agent ${i}`,
		capabilities: { surfaces: [], runtime: null, workflow: null },
	}));
	const instances = Array.from({ length: 6 }, (_, i) => ({
		id: `i-${i}`,
		agent_id: "agent-1",
		agent_name: `Agent ${i}`,
		agent_slug: "lead-finder",
		user_id: "user-2",
		owner_login: "creator-two",
		display_name: null,
		status: "active",
		created_at: "2026-07-01",
		runtime_nodes: 1,
		last_seen_at: null,
		runtimeConnected: true,
	}));
	const daily = Array.from({ length: 14 }, (_, i) => ({ date: `2026-07-${String(i + 1).padStart(2, "0")}`, costMicros: 1000 * (i + 1) }));
	const bucket = (key: string) => ({ key, label: key, inputTokens: 100, outputTokens: 50, costMicros: 2000, calls: 7 });

	await page.route(`${API}/**`, async (route) => {
		const path = new URL(route.request().url()).pathname;
		const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });

		if (path === "/v1/admin/me") return json({ admin: true });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "operator" });
		/**
		 * A COMPLETE `AdminUser`. The three-field version this replaced crashed the page it was
		 * meant to paint: `Users.tsx` calls `u.key_providers.join()` and `fmtUsd(u.value30dMicros)`
		 * unguarded, so React unmounted the whole tree and `<main>` never appeared. It went
		 * unnoticed because /admin/users renders no `<select>` and so was outside #414's route
		 * list — the same gap #435 is about, one layer down in the fixture.
		 */
		if (path === "/v1/admin/users") {
			return json({
				total: 2,
				users: [
					{ id: "user-1", github_login: "operator", github_name: "Operator", roles: ["admin", "user"], agents_owned: 2, active_instances: 3, key_providers: ["anthropic", "openai"], value30dMicros: 5_000_000, charged30dMicros: 5_000_000, suspended: 0, suspended_reason: null },
					{ id: "user-2", github_login: "a-long-github-login-name", github_name: "A Contributor With A Long Name", roles: ["creator", "user"], agents_owned: 1, active_instances: 1, key_providers: [], value30dMicros: 12_000, charged30dMicros: 0, suspended: 1, suspended_reason: "abuse" },
				],
			});
		}
		if (path === "/v1/admin/agents") return json({ agents, total: agents.length });
		if (path === "/v1/admin/instances") return json({ instances, total: instances.length });

		if (path === "/v1/admin/errors/summary" || path === "/v1/admin/errors") {
			const rows = ERROR_SOURCES.map((source, i) => ({
				id: `e-${i}`,
				key: `k-${i}`,
				source,
				sample: "TypeError: cannot read properties of undefined",
				pattern: "TypeError: cannot read properties of <id>",
				count: 3 + i,
				users: 1,
				firstSeen: "2026-07-01T00:00:00Z",
				lastSeen: "2026-07-08T00:00:00Z",
				lastStatus: 500,
				lastId: `e-${i}`,
				created_at: "2026-07-08T00:00:00Z",
				user_id: "user-2",
				message: "TypeError: cannot read properties of undefined",
				context: null,
				status: 500,
			}));
			return json(path.endsWith("/summary") ? { signatures: rows } : { errors: rows });
		}

		if (path.startsWith("/v1/admin/trace/")) {
			return json({
				events: ERROR_SOURCES.map((source, i) => ({
					id: `t-${i}`,
					ts: 1786000000 + i,
					created_at: "2026-07-08T00:00:00Z",
					user_id: "user-2",
					instance_id: "i-1",
					trace_id: "trace-1",
					source,
					level: i === 0 ? "error" : "info",
					event: "tool.call",
					message: "search_knowledge returned 4 chunks",
					context: null,
				})),
			});
		}

		if (path === "/v1/admin/audit") {
			return json({
				audit: [
					{ id: "a-1", created_at: "2026-07-08T00:00:00Z", actor_user_id: "user-1", actor_login: "operator", action: "agent.unpublish", target_type: "agent", target_id: "agent-1", detail: null },
				],
			});
		}

		if (path === "/v1/admin/usage") {
			return json({
				range: "30d",
				totals: { inputTokens: 1000, outputTokens: 500, costMicros: 90000, calls: 42 },
				daily,
				byProvider: [bucket("anthropic")], byModel: [bucket("claude-sonnet-4-6")], byKind: [bucket("chat")],
				byUser: [bucket("user-2")], byAgent: [bucket("agent-1")],
				split: { platformPaid: { costMicros: 40000, calls: 20 }, byok: { costMicros: 50000, chargedMicros: 50000, calls: 22 } },
			});
		}
		if (path === "/v1/admin/usage/external") {
			return json({
				externalUsers: 3,
				byAgent: [{ agentId: "agent-1", externalUsers: 3, calls: 10, valueMicros: 5000, chargedMicros: 5000 }],
				totals: { calls: 10, valueMicros: 5000, chargedMicros: 5000 },
				operator: { users: 1, calls: 2, valueMicros: 100, chargedMicros: 0 },
				operatorUnknown: false,
			});
		}
		if (path === "/v1/admin/spending") {
			return json({
				range: "30d",
				totals: { costMicros: 90000, calls: 42 },
				daily,
				byok: { costMicros: 50000, chargedMicros: 50000, calls: 22 },
				topSpenders: [bucket("user-2")],
				topModels: [bucket("claude-sonnet-4-6")],
				platformAiEnabled: true,
				platformPaid: { costMicros: 40000, calls: 20, metered: false, estimated: true, note: "Estimated from the AI usage ledger." },
			});
		}
		if (path === "/v1/admin/github/issues") {
			return json({
				repo: "ProAgentStore/platform",
				generatedAt: "2026-08-08T00:00:00Z",
				complete: true,
				fetched: 33,
				totals: { all: 33, open: 24, closed: 9 },
				bySeverity: {
					critical: { total: 1, open: 1, closed: 0 }, high: { total: 4, open: 3, closed: 1 },
					medium: { total: 10, open: 8, closed: 2 }, low: { total: 8, open: 6, closed: 2 },
					none: { total: 10, open: 6, closed: 4 },
				},
				labels: REPO_LABELS,
				history: daily.map((d) => ({ date: d.date, opened: 1, closed: 1, openTotal: 20, totalFiled: 30, totalClosed: 10 })),
				issues: [
					{ number: 414, title: "The operator portal's <select> rules have no paint containment", state: "open", labels: ["deferred: no demand"], severity: "medium", createdAt: "2026-08-08", closedAt: null, updatedAt: "2026-08-08", url: "https://example.invalid/414", comments: 0 },
				],
			});
		}

		/**
		 * The routes below paint no `<select>`, so #414's block never needed them — but #435
		 * measures `<main>` on EVERY operator route, and a page stuck on `<Loading />` measures
		 * zero overflow and passes. Same non-vacuity rule as above, same reason.
		 *
		 * The strings are long on purpose. #435's numbers are data-independent by construction
		 * (a `max-w-[420px]` cell cannot fit a 320px phone whatever it holds), but the rows that
		 * overflow because of a `whitespace-nowrap` hostname or an ISO timestamp are NOT — a
		 * fixture of short invented names would make this block vacuous, which is the hollow-fixture
		 * failure this file has already shipped twice.
		 */
		if (path === "/v1/admin/overview") {
			return json({
				users: 12, agents: 9, agentsPublished: 4, instancesActive: 7,
				errors24h: 3, aiCalls24h: 812, value30dMicros: 5_000_000, platformSpend30dMicros: 90_000,
			});
		}
		if (path === "/v1/admin/ops") {
			return json({
				errors24h: 3,
				stuckSessions: [
					{ id: "cs_01J9ZQ8F3K2M7NPRSTVWXY", instance_id: "inst_01J9ZQ8F3K2M7NPRSTVWXY", user_id: "user-2", owner_login: "creator-two", client_type: "claude", status: "needs_human", updated_at: "2026-08-08T00:21:19Z" },
					{ id: "cs_01J9ZQ8F3K2M7NPRSTVWXZ", instance_id: "inst_01J9ZQ8F3K2M7NPRSTVWXZ", user_id: "user-3", owner_login: "sergey-ivochkin", client_type: "codex", status: "blocked", updated_at: "2026-08-07T23:04:02Z" },
				],
				staleRunners: [
					{ instance_id: "inst_01J9ZQ8F3K2M7NPRSTVWXY", runner_node: "Sergeys-MacBook-Air.local", user_id: "user-2", owner_login: "creator-two", runner_version: "0.4.16", status: "connected", last_seen_at: "2026-08-08T00:21:19Z" },
				],
				noKeyUsers: [{ id: "user-4", github_login: "a-long-github-login-name", github_name: "A Contributor With A Long Name", active_instances: 2 }],
			});
		}
		if (path === "/v1/admin/triggers") {
			return json({
				count: 2,
				triggers: [
					{ id: "trg-1", agentName: "Small Business Website Lead Finder", ownerLogin: "sergey-ivochkin", name: "nightly sweep", type: "cron", action: "run_pipeline", enabled: true, hasSecret: false, schedule: "0 17 * * *", createdAt: "2026-08-01T00:00:00Z" },
					{ id: "trg-2", agentName: "Lead Outreach", ownerLogin: "creator-two", name: "inbound lead webhook", type: "webhook", action: "run_pipeline", enabled: false, hasSecret: true, schedule: null, createdAt: "2026-07-28T00:00:00Z" },
				],
			});
		}
		if (path === "/v1/admin/terminals") {
			return json({
				nodes: [
					{
						node: "Sergeys-MacBook-Air.local", ownerLogin: "sergey-ivochkin", runnerVersion: "0.4.16",
						lastSeenAt: "2026-08-08 00:21:19", connected: false,
						instances: [{ instanceId: "inst-1", name: "Repo Coder", agentSlug: "coder", status: "active", connected: false, bound: true, runtime: "coding" }],
						sessions: [{ sessionId: "cs-1", repoName: "ProAgentStore/platform", engine: "claude", status: "active", updatedAt: "2026-08-08T00:21:19Z", terminalTail: "» running pnpm vitest run\n" }],
					},
					{ node: "RLs-MacBook-Pro-16.local", ownerLogin: "creator-two", runnerVersion: "0.4.15", lastSeenAt: "2026-08-07 22:10:04", connected: true, instances: [], sessions: [] },
				],
			});
		}
		if (path === "/v1/admin/connectors") {
			return json({
				connectors: [
					{ connector: "github", tools: [{ name: "github_list_issues", scope: "read" }, { name: "github_create_issue", scope: "write" }], hasWrite: true },
					{ connector: "web-search", tools: [{ name: "web_search", scope: "read" }], hasWrite: false },
				],
				consents: [{ instance_id: "inst_01J9ZQ8F3K2M7NPRSTVWXY", user_id: "user-2", connector: "github", scope: "write", created_at: "2026-08-01T00:00:00Z", owner_login: "creator-two" }],
			});
		}
		if (path === "/v1/admin/mcp-audit") {
			return json({
				events: ERROR_SOURCES.map((source, i) => ({
					time: "2026-08-08T00:21:19Z", subject: `user:sergey-ivochkin`, tool: "coding_session_capture",
					action: i === 0 ? "denied" : "allowed", reason: i === 0 ? "scope not granted" : undefined,
					requiredScope: "runtime", scopes: ["read", "write", "runtime"], result: { source },
				})),
			});
		}

		return json({});
	});
}

/** Every admin route that renders a `<select>`, with how many it must render. */
const SELECT_ROUTES: Array<{ route: string; selects: number }> = [
	{ route: "/admin/errors", selects: 2 },
	{ route: "/admin/agents", selects: 2 },
	{ route: "/admin/instances", selects: 1 },
	{ route: "/admin/instances/i-1/trace", selects: 3 },
	{ route: "/admin/audit", selects: 2 },
	{ route: "/admin/usage", selects: 1 },
	{ route: "/admin/spending", selects: 1 },
	{ route: "/admin/github-issues", selects: 4 },
];

test.describe("mobile — no select widens the operator portal (#414)", () => {
	for (const width of [320, 390]) {
		for (const { route, selects } of SELECT_ROUTES) {
			test(`${route} is contained at ${width}px`, async ({ page }) => {
				await page.setViewportSize({ width, height: 812 });
				await mockAdminSurfaces(page);
				await page.goto(route);
				await page.waitForLoadState("networkidle");
				await page.locator("main").waitFor();
				await page.waitForTimeout(300);

				// NON-VACUITY FIRST. Every one of these pages early-returns `<Loading />` before its
				// filter bar when its data is null, so a fixture gap does not fail this block — it
				// makes it pass by measuring an empty page. #414's own attempt at this measurement
				// covered 9 of 16 selects for exactly that reason and could not tell "admin is fine"
				// from "admin never painted".
				expect(await page.locator("main select").count(), `${route} did not render its ${selects} select(s) — fixture gap, not a pass`).toBe(selects);

				const { rowOffenders, escaped } = await page.evaluate(() => {
					const rowOffenders: string[] = [];
					const escaped: string[] = [];
					const label = (s: HTMLSelectElement) => s.getAttribute("aria-label") || s.id || "?";
					const widestOption = (s: HTMLSelectElement) => Array.from(s.options).reduce((a, o) => (o.text.length > a.length ? o.text : a), "");

					for (const el of Array.from(document.querySelectorAll("main select"))) {
						const s = el as HTMLSelectElement;

						// (a) The control's own box must not reach past the viewport. Cheap, and it
						//     covers the case where the row IS a scroller and therefore absorbs the
						//     overflow that (b) measures.
						const r = s.getBoundingClientRect();
						if (r.width > 0 && r.right > window.innerWidth + 1) {
							escaped.push(`select[${label(s)}] right ${Math.round(r.right)} > ${window.innerWidth}`);
						}

						// (b) The control must not widen the row it sits in.
						const row = s.parentElement;
						if (!row) continue;
						const before = row.scrollWidth - row.clientWidth;
						if (before <= 1) continue;
						// ATTRIBUTION, not correlation: these filter bars put several selects in one
						// flex row, so the row's overflow reads identically on all of them and would
						// blame the innocent. Take the control out of flow and re-measure — if the row
						// stops overflowing without it, it is the one that did it, and the widest
						// option is what escaped.
						s.style.display = "none";
						const without = row.scrollWidth - row.clientWidth;
						s.style.display = "";
						if (without > 1) continue;
						rowOffenders.push(`select[${label(s)}] (widest option "${widestOption(s)}") widens its row by ${before}px`);
					}

					return { rowOffenders, escaped };
				});

				expect(rowOffenders, rowOffenders.join("; ")).toEqual([]);
				expect(escaped, escaped.join("; ")).toEqual([]);
			});
		}
	}

	/**
	 * Containment does not change the focus indicator — measured as an A/B, not asserted as a fact
	 * about box-shadow (#414).
	 *
	 * `contain: paint` clips a control's contents to its own padding box, and the way to get this
	 * badly wrong is to close an overflow ticket with something that also removes the focus ring.
	 * #414 asked for this to be verified rather than assumed, and verifying it turned up something
	 * the obvious assertion would have got wrong, so the mechanism is worth stating.
	 *
	 * THE OBVIOUS TEST — "a focused select has a box-shadow" — IS WRONG, and it fails for a reason
	 * that has nothing to do with this change. Measured on the same run, macOS WebKit 2272:
	 *
	 *                       contain: paint      contain: none !important
	 *     admin  box-shadow     none                    none
	 *     console box-shadow    none                    none
	 *     a plain <button>   rgba(124,58,237,.15) 0 0 0 3px   (both engines, both modes)
	 *
	 * So WebKit drops `box-shadow` on a NATIVE MENULIST specifically — the same shape as it
	 * overriding `overflow` on the same element, which is the whole reason #384 ended at
	 * `contain: paint`. It is identical with containment on and off, it is identical on the
	 * console (which has shipped `contain: paint` since 79bf551), and Chromium reports the shadow
	 * in every combination. That makes it PRE-EXISTING and engine-specific, not something this
	 * commit introduced — and admin still shows a focus indicator there via `border-color`, which
	 * WebKit does honour (measured `rgb(124, 58, 237)` on focus). It is worth its own ticket; it
	 * is not this one, and asserting it here would have been a red guard blaming the wrong change.
	 *
	 * THAT TICKET WAS #436, AND IT IS NOW FIXED. This measurement was right in every particular
	 * and the deferral was right too — the ring's absence in WebKit is the element, not the
	 * containment. `select:focus-visible { outline }` now carries the indicator in both trees, and
	 * `a focused select is visibly focused` below asserts it directly. The A/B here is unchanged
	 * and still owns its own question: whatever the indicator is, containment must not eat it.
	 * That is why it compares WITH against WITHOUT rather than naming a property — it keeps
	 * working now that the property has changed, which is the point of writing it that way.
	 *
	 * WHAT IS ASSERTED INSTEAD is the invariant this commit is actually responsible for: whatever
	 * the focus indicator is in this engine, turning paint containment OFF does not change it.
	 * That is engine-independent, it is exactly the question "does the containment eat the ring",
	 * and it goes red for the failures that matter — a ring re-expressed as an `outline` (which
	 * paint containment DOES clip), or `appearance: none` smuggled in, or the ring moved inside
	 * the padding box. The companion `contain` assertion keeps the rule itself present, so this
	 * cannot pass by there being no containment to compare against.
	 */
	test("paint containment does not change the focus indicator", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 812 });
		await mockAdminSurfaces(page);
		await page.goto("/admin/errors");
		await page.waitForLoadState("networkidle");

		const select = page.locator("main select").first();
		await select.waitFor();
		await select.focus();

		/** Everything a user could perceive as "this control is focused". */
		const readIndicator = () =>
			page.evaluate(() => {
				const s = document.querySelector("main select") as HTMLSelectElement;
				const cs = getComputedStyle(s);
				return {
					focused: s.matches(":focus"),
					contain: cs.contain,
					boxShadow: cs.boxShadow,
					outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`,
					borderColor: cs.borderColor,
					appearance: cs.appearance,
				};
			});

		const withContainment = await readIndicator();
		expect(withContainment.focused, "the select never took focus, so this measures nothing").toBe(true);
		expect(withContainment.contain, "paint containment is not applied to <select> in store/admin/src/index.css").toContain("paint");
		// A native menulist, still. `appearance: none` was rejected in #384 and #414 precisely
		// because it fixes the overflow by replacing the platform widget.
		expect(withContainment.appearance, "the select stopped being a native menulist").not.toBe("none");

		await page.addStyleTag({ content: "select { contain: none !important; }" });
		await select.focus();
		const withoutContainment = await readIndicator();
		expect(withoutContainment.contain).toBe("none");

		expect(
			{ ...withContainment, contain: "-" },
			`the focus indicator changed when paint containment was removed — containment is eating it. with: ${JSON.stringify(withContainment)} / without: ${JSON.stringify(withoutContainment)}`,
		).toEqual({ ...withoutContainment, contain: "-" });
	});

	/**
	 * A focused `<select>` is VISIBLY focused, in this tree too (#436, WCAG 2.4.7).
	 *
	 * The A/B above answers "does containment eat the indicator". This answers the question it
	 * deliberately left open: "is there an indicator at all". They are different, and only the
	 * second one goes red on the defect #436 filed — the portal was down to a 1px `border-color`
	 * transition against a #0a0a0a background on all 16 controls, because WebKit computes
	 * `box-shadow` to `none` on a native menulist and `outline: none` is declared on the same rule.
	 *
	 * Asserted on PIXELS as well as computed style, over a region larger than the control, for the
	 * reason the console's twin states at length: computed style is what got this wrong the first
	 * time, and an `outline` with an `outline-offset` paints outside the border box, so an
	 * element-clipped screenshot would miss it.
	 */
	test("mobile — a focused select is visibly focused", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 812 });
		await mockAdminSurfaces(page);
		await page.goto("/admin/errors");
		await page.waitForLoadState("networkidle");
		await page.locator("main select").first().waitFor();
		await page.waitForTimeout(300);

		const sel = page.locator("main select").first();
		await sel.scrollIntoViewIfNeeded();
		const box = await sel.boundingBox();
		if (!box) throw new Error("the select has no box");
		const clip = { x: box.x - 6, y: box.y - 6, width: box.width + 12, height: box.height + 12 };

		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
		const blurred = await page.screenshot({ clip });
		await sel.focus();
		const focused = await page.screenshot({ clip });

		const style = await page.evaluate(() => {
			const s = document.querySelector("main select") as HTMLSelectElement;
			const cs = getComputedStyle(s);
			return { focused: s.matches(":focus"), outlineStyle: cs.outlineStyle, boxShadow: cs.boxShadow, borderColor: cs.borderColor, appearance: cs.appearance };
		});

		expect(style.focused, "the select never took focus, so this measures nothing").toBe(true);
		expect(style.appearance, "the select stopped being a native menulist").not.toBe("none");
		expect(
			blurred.equals(focused),
			`focusing the select changed no pixels — the indicator computes but does not paint: ${JSON.stringify(style)}`,
		).toBe(false);
	});
});

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * mobile — no operator route pans sideways (#435)
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * Eight of the fourteen operator routes were horizontally pannable on a phone. `/admin/errors`
 * dragged a 782px page through a 320px window to read an error message: `main.scrollWidth −
 * main.clientWidth` measured 462px at 320 and 392 at 390, with the table laying out at 749px.
 * Engine-independent — Chromium and WebKit gave byte-identical numbers at both widths.
 *
 * ── Why this is a guard and not just nine wrappers
 *
 * The remedy was already in this repo: `<div className="overflow-x-auto">` around the table, on
 * six pages. The measurements split exactly along that line — `/admin/agents` carries a **904px**
 * table and measured **0**, `/admin/errors` carries a 749px one and measured 462. So this was
 * never a design problem, it was a wrapper that nine call sites never got, and nine misses out of
 * fifteen means the tenth table would have missed it too. The assertion is the deliverable; the
 * wrappers are just what makes it green today.
 *
 * ── Why `<main>` is asserted HERE and not in the #414 block above
 *
 * The `mobile — no select widens the operator portal` block deliberately does NOT assert `<main>`,
 * and its comment explains why: running it found real page-level overflow on `/admin/errors` with
 * ZERO select offenders, so asserting it there would have made #414's guard permanently red on
 * somebody else's defect. That defect is this one. It now has its own block, its own name and its
 * own fix — which is the correct end state for that scope decision, not a contradiction of it.
 *
 * ── `mobile — `, load-bearing
 *
 * `playwright.config.ts` scopes the WebKit project with `grep: /mobile — /`. Without the prefix
 * this silently runs in one engine, which is the #333 shape and is exactly what left the operator
 * portal unmeasured until #414.
 */

/**
 * Every route in `store/admin/src/App.tsx` that a `<Layout>` renders, with a string that proves
 * the page PAINTED. The non-vacuity check is not optional here: every one of these pages
 * early-returns `<Loading />` or `<Empty />` before its table, and both measure zero overflow.
 * A fixture gap would not fail this block — it would make it pass by measuring nothing.
 *
 * The strings are chosen to come from ROW DATA and from nothing else. `agent.unpublish` was the
 * first attempt for /admin/audit and is wrong for an instructive reason: it is also an `<option>`
 * in that page's action filter, options inside a closed `<select>` are not visible, and `.first()`
 * picks the option. A non-vacuity check that can be satisfied by a filter control is not one.
 */
const PORTAL_ROUTES: Array<{ route: string; painted: string }> = [
	{ route: "/admin/", painted: "Users" },
	{ route: "/admin/errors", painted: "TypeError: cannot read properties of undefined" },
	{ route: "/admin/users", painted: "a-long-github-login-name" },
	{ route: "/admin/agents", painted: "Agent 0" },
	{ route: "/admin/instances", painted: "creator-two" },
	{ route: "/admin/terminals", painted: "Sergeys-MacBook-Air.local" },
	{ route: "/admin/connectors", painted: "github_create_issue" },
	{ route: "/admin/ops", painted: "needs_human" },
	{ route: "/admin/github-issues", painted: "The operator portal's <select> rules have no paint containment" },
	{ route: "/admin/triggers", painted: "Small Business Website Lead Finder" },
	{ route: "/admin/mcp-audit", painted: "coding_session_capture" },
	{ route: "/admin/usage", painted: "claude-sonnet-4-6" },
	{ route: "/admin/spending", painted: "claude-sonnet-4-6" },
	{ route: "/admin/audit", painted: "agent:agent-1" },
];

test.describe("mobile — no operator route pans sideways (#435)", () => {
	for (const width of [320, 390]) {
		for (const { route, painted } of PORTAL_ROUTES) {
			test(`${route} does not pan at ${width}px`, async ({ page }) => {
				await page.setViewportSize({ width, height: 812 });
				await mockAdminSurfaces(page);
				await page.goto(route);
				await page.waitForLoadState("networkidle");
				await page.locator("main").waitFor();
				await page.waitForTimeout(300);

				// NON-VACUITY FIRST — see the note on PORTAL_ROUTES.
				await expect(page.locator("main").getByText(painted).first(), `${route} never painted its content — fixture gap, not a pass`).toBeVisible();

				const { mainOv, docOv, offenders } = await page.evaluate(() => {
					const m = document.querySelector("main");
					const offenders: string[] = [];
					// ATTRIBUTION, because "the page is 462px too wide" names nobody and is the
					// reason #414 asked for offenders by class on the console's equivalent. A table
					// wider than the box it sits in, whose ancestors do not scroll, IS the defect.
					for (const el of Array.from(m?.querySelectorAll("table") ?? [])) {
						let scrolled = false;
						for (let p = el.parentElement; p && p !== m; p = p.parentElement) {
							const ox = getComputedStyle(p).overflowX;
							if (ox === "auto" || ox === "scroll") { scrolled = true; break; }
						}
						const w = Math.round(el.getBoundingClientRect().width);
						if (!scrolled && m && w > m.clientWidth + 1) offenders.push(`a ${w}px table in no scroller`);
					}
					return { mainOv: m ? m.scrollWidth - m.clientWidth : 0, docOv: document.documentElement.scrollWidth - window.innerWidth, offenders };
				});

				expect(offenders, `${route} @${width}w: ${offenders.join(", ")}`).toEqual([]);
				expect(mainOv, `<main> pans by ${mainOv}px at ${width}w on ${route}`).toBeLessThanOrEqual(1);
				expect(docOv, `page overflows by ${docOv}px at ${width}w on ${route}`).toBeLessThanOrEqual(1);
			});
		}
	}

	/**
	 * The scroller keeps every column REACHABLE — the alternative this fix was chosen over
	 * (`table-layout: fixed` + truncated cells) makes the page fit and stop being useful, which is
	 * the whole job of a portal whose content is long error signatures and MCP tool names.
	 *
	 * So the table is asserted to still be WIDER than its scroller and to actually scroll. Without
	 * this, `overflow-x-auto` on a table that had been squashed to fit would pass every assertion
	 * above while having silently thrown the data away.
	 */
	test("mobile — the errors table scrolls inside its panel instead of hiding columns", async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 812 });
		await mockAdminSurfaces(page);
		await page.goto("/admin/errors");
		await page.waitForLoadState("networkidle");
		await page.locator("main table").waitFor();
		await page.waitForTimeout(300);

		const m = await page.evaluate(() => {
			const table = document.querySelector("main table") as HTMLElement;
			const box = table.parentElement as HTMLElement;
			return {
				overflowX: getComputedStyle(box).overflowX,
				tableWidth: Math.round(table.getBoundingClientRect().width),
				boxWidth: box.clientWidth,
				scrollable: box.scrollWidth - box.clientWidth,
			};
		});

		expect(m.overflowX, `the table's box is ${m.overflowX}, not a scroller: ${JSON.stringify(m)}`).toBe("auto");
		// The columns are still their natural width — this is the check that the fix did not
		// become "make it fit by ellipsising the operator's data".
		expect(m.tableWidth, `the table was squashed to ${m.tableWidth}px — the columns were hidden, not scrolled: ${JSON.stringify(m)}`).toBeGreaterThan(m.boxWidth);
		expect(m.scrollable, `the box does not actually scroll: ${JSON.stringify(m)}`).toBeGreaterThan(1);
	});
});
