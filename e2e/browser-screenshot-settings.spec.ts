import { expect, test, type Page } from "@playwright/test";

// #1433: the owner chooses capture and form-field blur independently. All API calls are mocked;
// real settings controls must send partial patches, render the response, and survive a reload.
const API = "https://api.proagentstore.online";
const INSTANCE = { id: "inst-1", agent_id: "agent-1", name: "Browser QA", status: "active", slug: "browser-qa", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: [], runtime: "browser", workflow: "BROWSER_TASK" } };

async function mock(page: Page, refuse = false) {
	await page.addInitScript(() => window.localStorage.setItem("pags:session", "test-pags-token"));
	const stored = { enabled: true, blurFormFields: true };
	const puts: unknown[] = [];
	await page.route(`${API}/**`, async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", roles: ["user"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: [INSTANCE] });
		if (path === "/v1/instances/inst-1/browser-screenshots") {
			if (req.method() === "PUT") {
				const body = req.postDataJSON();
				puts.push(body);
				if (refuse) return json({ error: "Could not save screenshot preferences" }, 400);
				Object.assign(stored, body);
			}
			return json({ ...stored, explained: "Capture browser screenshots for your replay." });
		}
		return json({ error: "Not mocked" }, 404);
	});
	return { puts };
}

test("mobile — screenshot capture and form blur save independently at 375px", async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const { puts } = await mock(page);
	await page.goto("/console/instances/inst-1/settings");
	const card = page.getByTestId("browser-screenshot-settings");
	const capture = card.getByRole("checkbox", { name: "Capture screenshots for run replay" });
	const blur = card.getByRole("checkbox", { name: "Blur form fields" });
	await expect(capture).toBeChecked();
	await expect(blur).toBeChecked();
	await blur.click();
	await expect(card.getByRole("status")).toContainText("Saved");
	expect(puts).toEqual([{ blurFormFields: false }]);
	await expect(capture).toBeChecked();
	await page.reload();
	await expect(blur).not.toBeChecked();
	await expect(capture).toBeChecked();
	await capture.click();
	await expect(card).toContainText("Future runs save no screenshots, regardless of the blur setting");
	await expect(blur).not.toBeChecked();
	await blur.click();
	await expect(card.getByRole("status")).toContainText("Saved");
	await expect(capture).not.toBeChecked();
	expect(puts).toEqual([{ blurFormFields: false }, { enabled: false }, { blurFormFields: true }]);
	await page.reload();
	await expect(blur).toBeChecked();
	await expect(capture).not.toBeChecked();
	await capture.click();
	await expect(card.getByRole("status")).toContainText("Saved");
	await expect(blur).toBeChecked();
	expect(puts).toEqual([{ blurFormFields: false }, { enabled: false }, { blurFormFields: true }, { enabled: true }]);
	await expect(card).toContainText("visible form values in your owner-only replay");
	await expect(card).toContainText("The site's password bullets stay as shown");
	await card.scrollIntoViewIfNeeded();
	const box = await card.boundingBox();
	expect(box && box.x >= 0 && box.x + box.width <= 375).toBe(true);
	expect(await card.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
});

test("a refused blur change keeps the saved value and shows the error", async ({ page }) => {
	const { puts } = await mock(page, true);
	await page.goto("/console/instances/inst-1/settings");
	const card = page.getByTestId("browser-screenshot-settings");
	const blur = card.getByRole("checkbox", { name: "Blur form fields" });
	await blur.click();
	await expect(card.getByRole("status")).toContainText("Could not save screenshot preferences");
	await expect(blur).toBeChecked();
	await expect(card.getByRole("checkbox", { name: "Capture screenshots for run replay" })).toBeChecked();
	expect(puts).toEqual([{ blurFormFields: false }]);
	await page.reload();
	await expect(blur).toBeChecked();
});
