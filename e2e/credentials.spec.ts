import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * #1226 — the owner's site logins in the console: list, reveal + copy, add, change/rotate, delete.
 *
 * The vault routes existed; the panel was read-only (domain and username), so a password the agent
 * signs in with could never be seen or changed by its owner. These drive the real Knowledge →
 * Credentials page against a stub of those routes and assert what each action SENDS — in particular
 * that the list carries no secret, a reveal is the only way a password reaches the page, and an edit
 * with a blank password never overwrites the stored one.
 */
const API = "https://api.proagentstore.online";
const INSTANCE = { id: "inst-1", agent_id: "agent-1", name: "Job Application Runner", status: "active", slug: "job-application-runner", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: [], runtime: "local_apply", workflow: null } };
const SEEK = { id: "cred-1", domain: "seek.com.au", username: "serge.pro.job@gmail.com", loginUrl: "https://login.seek.com/login", hasPassword: true, hasPin: false, hasRecoveryCodes: false, createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z" };
const PASSWORD = "Xk7#mQ2!pR9v@Lw4Zt8$";

async function mockVault(page: Page) {
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), "test-pags-token");
	let creds: Array<Record<string, unknown>> = [{ ...SEEK }];
	const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
	await page.route(`${API}/**`, async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
		const body = req.postData() ? (req.postDataJSON() as Record<string, unknown>) : null;
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: [INSTANCE] });
		if (path.startsWith("/v1/instances/inst-1/credentials")) {
			calls.push({ method: req.method(), path, body });
			if (path === "/v1/instances/inst-1/credentials" && req.method() === "GET") return json({ credentials: creds });
			if (path === "/v1/instances/inst-1/credentials/cred-1/reveal") return json({ ...SEEK, password: PASSWORD });
			if (path === "/v1/instances/inst-1/credentials" && req.method() === "POST") {
				creds = [...creds, { id: "cred-2", domain: body?.domain, username: body?.username, hasPassword: !!body?.password }];
				return json({ id: "cred-2", ok: true }, 201);
			}
			if (req.method() === "PUT") return json({ ok: true });
			if (req.method() === "DELETE") {
				creds = creds.filter((c) => !path.endsWith(`/${c.id}`));
				return json({ ok: true });
			}
		}
		return json({});
	});
	return { calls };
}

const open = async (page: Page) => {
	await page.goto("/console/instances/inst-1/knowledge?subtab=credentials");
	await expect(page.getByTestId("credentials-section")).toBeVisible();
};

test.describe("site logins in the console (#1226)", () => {
	test("the list shows each login with no secret on the page — a password arrives only on Reveal, then copies and hides", async ({ page, context }) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
		const { calls } = await mockVault(page);
		await open(page);
		const row = page.getByTestId("credential-row");
		await expect(row).toContainText("seek.com.au");
		await expect(row).toContainText("serge.pro.job@gmail.com");
		await expect(row).toContainText("password stored");
		await expect(page.locator("body")).not.toContainText(PASSWORD);
		expect(calls.filter((c) => c.path.endsWith("/reveal"))).toEqual([]);

		await row.getByRole("button", { name: "Reveal" }).click();
		const shown = page.getByTestId("credential-revealed");
		await expect(shown).toContainText(PASSWORD);
		await expect(shown).toContainText("recorded in the agent's trace");
		expect(calls.filter((c) => c.path.endsWith("/reveal"))).toHaveLength(1);

		await shown.getByRole("button", { name: "Copy" }).click();
		await expect(shown.getByRole("button", { name: "Copied" })).toBeVisible();

		await shown.getByRole("button", { name: "Hide" }).click();
		await expect(page.locator("body")).not.toContainText(PASSWORD);
	});

	test("an edit with a blank password changes the username and keeps the stored password", async ({ page }) => {
		const { calls } = await mockVault(page);
		await open(page);
		await page.getByTestId("credential-row").getByRole("button", { name: "Edit" }).click();
		const form = page.getByTestId("credential-form");
		await expect(form.getByRole("textbox", { name: "Username or email" })).toHaveValue("serge.pro.job@gmail.com");
		await expect(form.getByLabel("New password (blank keeps the current one)")).toHaveValue("");
		await form.getByRole("textbox", { name: "Username or email" }).fill("serge@example.com");
		await form.getByRole("button", { name: "Save" }).click();
		await expect(form).toHaveCount(0);
		const put = calls.find((c) => c.method === "PUT");
		expect(put?.path).toBe("/v1/instances/inst-1/credentials/cred-1");
		expect(put?.body).toMatchObject({ username: "serge@example.com" });
		expect(put?.body).not.toHaveProperty("password");
	});

	test("rotating: Generate fills a strong password, and Save sends it", async ({ page }) => {
		const { calls } = await mockVault(page);
		await open(page);
		await page.getByTestId("credential-row").getByRole("button", { name: "Edit" }).click();
		const form = page.getByTestId("credential-form");
		await form.getByRole("button", { name: "Generate" }).click();
		const generated = await form.getByLabel("New password (blank keeps the current one)").inputValue();
		expect(generated).toHaveLength(20);
		expect(generated).toMatch(/[a-z]/);
		expect(generated).toMatch(/[A-Z]/);
		expect(generated).toMatch(/[2-9]/);
		expect(generated).toMatch(/[!@#$%^&*\-_=+?]/);
		await form.getByRole("button", { name: "Save" }).click();
		await expect(form).toHaveCount(0);
		expect(calls.find((c) => c.method === "PUT")?.body).toMatchObject({ password: generated });
	});

	test("adds a login, and deletes one after a confirmation", async ({ page }) => {
		const { calls } = await mockVault(page);
		await open(page);
		await page.getByRole("button", { name: "Add a login" }).click();
		const form = page.getByTestId("credential-form");
		await form.getByRole("textbox", { name: "Site (domain)" }).fill("indeed.com");
		await form.getByRole("textbox", { name: "Username or email" }).fill("serge.pro.job@gmail.com");
		await form.getByLabel("Password").fill("Correct-Horse-9!");
		await form.getByRole("button", { name: "Save" }).click();
		await expect(page.getByTestId("credential-row")).toHaveCount(2);
		expect(calls.find((c) => c.method === "POST")?.body).toEqual({ domain: "indeed.com", username: "serge.pro.job@gmail.com", password: "Correct-Horse-9!" });

		page.once("dialog", (d) => void d.accept());
		await page.getByTestId("credential-row").filter({ hasText: "seek.com.au" }).getByRole("button", { name: "Delete" }).click();
		await expect(page.getByTestId("credential-row")).toHaveCount(1);
		expect(calls.find((c) => c.method === "DELETE")?.path).toBe("/v1/instances/inst-1/credentials/cred-1");
	});

	test("mobile — the panel fits a phone: nothing scrolls sideways with a revealed password", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await mockVault(page);
		await open(page);
		await page.getByTestId("credential-row").getByRole("button", { name: "Reveal" }).click();
		await expect(page.getByTestId("credential-revealed")).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	});
});
