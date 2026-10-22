import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * #1282 — Preferences → Default coding engine, clicked in a browser against a stub that applies the route's contract: `defaultEngineId`
 * must be present, `null`/"" clears it, an unknown id is refused. The wire shapes and the real route are covered in
 * lib/codingDefault.test.ts and workers/api; this shows the control sends them, and shows only what the server confirmed.
 */
const API = "https://api.proagentstore.online";
const ENGINES = [{ id: "claude", label: "Claude Code" }, { id: "codex", label: "Codex" }];

async function mock(page: Page, opts: { refuse?: () => boolean } = {}) {
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), "test-pags-token");
	let stored: { defaultEngineId?: string } = {};
	const puts: unknown[] = [];
	await page.route(`${API}/**`, async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user", "creator"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: [] });
		if (path === "/v1/connectors") return json({ connectors: [] });
		if (path === "/v1/notifications") return json({ notifications: [], unreadCount: 0 });
		if (path === "/v1/preferences") {
			if (req.method() === "PUT") {
				const body = req.postDataJSON() as { coding?: { defaultEngineId?: unknown } };
				puts.push(body);
				if (opts.refuse?.()) return json({ error: "The server refused that." }, 503);
				if (body.coding) {
					const id = body.coding.defaultEngineId;
					if (id === undefined) return json({ error: "coding.defaultEngineId must be an engine id" }, 400);
					stored = id === null || id === "" ? {} : { defaultEngineId: String(id) };
				}
				return json({ preferences: { coding: stored } });
			}
			return json({ preferences: { voice: { speed: 130, sttMode: "openai" }, coding: stored }, languages: [{ name: "English", tag: "en-US" }], codingEngineOptions: ENGINES });
		}
		return json({ error: "not mocked" }, 404);
	});
	return { puts, stored: () => stored };
}

const engine = (page: Page) => page.getByLabel("Engine", { exact: true });

test.describe("Preferences default coding engine (#1282)", () => {
	test("pick an engine, then Platform default: the override is cleared with null, and a reload agrees", async ({ page }) => {
		const { puts, stored } = await mock(page);
		await page.goto("/console/preferences");
		await engine(page).selectOption("codex");
		await expect(page.getByText("Saved — future coder sessions")).toBeVisible();
		expect(stored()).toEqual({ defaultEngineId: "codex" });

		await engine(page).selectOption("");
		await expect(engine(page)).toHaveValue("");
		await expect.poll(() => puts.at(-1)).toEqual({ coding: { defaultEngineId: null } });
		await expect(page.getByRole("alert")).toHaveCount(0);
		expect(stored()).toEqual({});

		await page.reload();
		await expect(engine(page)).toHaveValue("");
	});

	test("a refused reset puts the control back on the stored engine and says it was not saved", async ({ page }) => {
		let refuse = false;
		const { stored } = await mock(page, { refuse: () => refuse });
		await page.goto("/console/preferences");
		await engine(page).selectOption("codex");
		await expect(page.getByText("Saved — future coder sessions")).toBeVisible();
		refuse = true;
		await engine(page).selectOption("");
		await expect(page.getByRole("alert")).toContainText("Not saved — The server refused that.");
		await expect(engine(page)).toHaveValue("codex");
		expect(stored()).toEqual({ defaultEngineId: "codex" });
		await page.reload();
		await expect(engine(page)).toHaveValue("codex");
	});
});
