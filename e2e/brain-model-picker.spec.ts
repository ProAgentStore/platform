import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * #1284 — the Settings tab's Brain model picker, measured at the widths where it was clipped.
 *
 * A native select sizes itself to its longest option. Those options carry provider, cost and, without Cloudflare credentials, "(needs
 * Cloudflare credentials)" — ~850px — and the picker's `sm:w-auto` let the control keep that width from 640px up. The Settings tab clips
 * horizontally (`overflow-x-hidden`), so nothing scrolled: the right edge and arrow were simply cut off, which a document-overflow check
 * cannot see. This asserts the CONTROL's box against the clipping container's, with the real options and the missing-credential state.
 * `mobile — ` titles keep these in the WebKit project too (playwright.config.ts).
 */
const API = "https://api.proagentstore.online";
const INSTANCE = { id: "inst-1", agent_id: "agent-1", name: "Repo Coder", status: "active", slug: "repo-coder", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION" } };

async function mock(page: Page) {
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), "test-pags-token");
	await page.route(`${API}/**`, async (route) => {
		const path = new URL(route.request().url()).pathname;
		const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: [INSTANCE] });
		if (path === "/v1/instances/inst-1/state") return json({ model: "claude-sonnet-4-6", modelChosen: true });
		// An Anthropic key and NO Cloudflare one: the Cloudflare options are disabled and carry their credential explanation.
		if (path === "/v1/keys/status") return json({ providers: [{ id: "anthropic", hasKey: true }, { id: "cloudflare", hasKey: false }] });
		if (path === "/v1/instances/inst-1/po-triage/reports") return json({ settings: null, triggers: [], reports: [] });
		if (path === "/v1/instances/inst-1/coder-questions") return json({ settings: null, questions: [] });
		if (path === "/v1/instances/inst-1/operator-manual") return json({ manual: "", inherited: "", sections: { inherited: null, instance: null }, combined: "", rules: "", context: "" });
		if (path === "/v1/instances/inst-1/coding/engine-choice") return json({ defaultEngineId: "claude", engines: [{ id: "claude", label: "Claude Code", command: "claude", clientType: "claude", model: null, modelSelectable: true, suggestions: [] }], lastObserved: null, appliesTo: "" });
		if (path === "/v1/triggers") return json({ triggers: [] });
		if (path === "/v1/triggers/actions") return json({ actions: [] });
		if (path === "/v1/triggers/preview") return json({ schedule: null, timezone: null, jitterMinutes: null, runs: [], issues: [], error: null });
		// An unmocked route fails like an unreachable one; a bare `{}` 200 crashes cards that read a list off it.
		return json({ error: "not mocked" }, 404);
	});
}

/** The select's box, and the box of the nearest ancestor that clips horizontally — what the owner can actually see of it. */
async function geometry(page: Page) {
	return page.getByLabel("Brain model").evaluate((el) => {
		const r = el.getBoundingClientRect();
		let clip: Element | null = el.parentElement;
		while (clip && getComputedStyle(clip).overflowX === "visible") clip = clip.parentElement;
		const c = (clip ?? document.documentElement).getBoundingClientRect();
		return { left: r.left, right: r.right, width: r.width, clipLeft: c.left, clipRight: c.right, clipped: !!clip };
	});
}

test.describe("Settings Brain model picker (#1284)", () => {
	for (const width of [375, 640, 768, 1280]) {
		test(`mobile — the whole select and its arrow stay inside the Settings content at ${width}px, with the real options`, async ({ page }) => {
			await mock(page);
			await page.setViewportSize({ width, height: 900 });
			await page.goto("/console/instances/inst-1/settings");
			const select = page.getByLabel("Brain model");
			await expect(select).toBeVisible();

			// The information is still there: provider, cost, and the missing-credential note on the unavailable options.
			const options = await select.locator("option").allTextContents();
			expect(options.length).toBeGreaterThan(2);
			expect(options.some((o) => o.includes("(needs Cloudflare credentials)"))).toBe(true);
			expect(options.every((o) => o.includes(" · ") && o.includes(" — "))).toBe(true);
			await expect(page.getByTestId("brain-prerequisites")).toBeVisible();

			// The control itself, not the document: the container clips, so scrollWidth stays flat while the edge is cut off.
			const g = await geometry(page);
			expect(g.clipped, "Settings should clip horizontally, or this measures the wrong box").toBe(true);
			expect(g.left).toBeGreaterThanOrEqual(g.clipLeft);
			expect(g.right).toBeLessThanOrEqual(g.clipRight);
			// ...and it uses the width it has rather than collapsing: the full control is the card's content width.
			const card = await page.getByTestId("brain-model-card").boundingBox();
			expect(card).not.toBeNull();
			expect(g.width).toBeGreaterThan((card?.width ?? 0) * 0.6);
		});
	}
});
