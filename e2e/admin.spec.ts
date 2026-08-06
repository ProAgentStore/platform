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
