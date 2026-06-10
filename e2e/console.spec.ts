import { expect, test } from "@playwright/test";

test.describe("ProAgentStore Console smoke", () => {
	test("console root renders the sign-in screen", async ({ page }) => {
		await page.goto("/");

		await expect(page).toHaveTitle(/Creator Console/);
		await expect(
			page.getByRole("heading", { name: "Creator Console" }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: /Sign in with GitHub/i }),
		).toBeVisible();
	});

	test("console route also serves the console shell", async ({ page }) => {
		await page.goto("/console");

		await expect(page).toHaveTitle(/Creator Console/);
		await expect(
			page.getByRole("heading", { name: "Creator Console" }),
		).toBeVisible();
	});

	test("ops and user-owned AI controls are present in the console bundle", async ({
		page,
	}) => {
		await page.goto("/");

		const html = await page.locator("html").evaluate((el) => el.innerHTML);
		expect(html).toContain("AI Billing");
		expect(html).toContain("Runtime Health");
		expect(html).toContain("Verify Key");
		expect(html).toContain("Cloudflare account ID");
		expect(html).toContain("triggerDeploy");
	});
});

test.describe("ProAgentStore live API smoke", () => {
	test("providers include Cloudflare Workers AI", async ({ request }) => {
		const res = await request.get(
			"https://api.proagentstore.online/v1/keys/providers",
		);
		expect(res.ok()).toBe(true);

		const data = (await res.json()) as {
			providers: Array<{ id: string; name: string }>;
		};
		expect(data.providers).toContainEqual(
			expect.objectContaining({
				id: "cloudflare",
				name: "Cloudflare Workers AI",
			}),
		);
	});
});
