import { expect, test } from "@playwright/test";

/**
 * #1120 — a test browser cannot write to production. Unmocked, a request to the API fails in the browser
 * (the chromium project maps the host to nothing); mocked, `page.route` answers exactly as before.
 */
const API = "https://api.proagentstore.online";
/**
 * `no-cors`, so the answer is about the NETWORK and never CORS: a request that reaches a server resolves
 * (an opaque response, status 0); only one the browser could not send rejects. `/health` writes nothing.
 */
const probe = (url: string) => fetch(url, { mode: "no-cors" }).then((r) => `reached (status ${r.status})`, (e: Error) => `failed: ${e.name}`);

test.describe("a test browser never reaches production (#1120)", () => {
	test("an unmocked request — an error report included — fails in the browser instead of reaching production", async ({ page, browserName }) => {
		test.skip(browserName !== "chromium", "the host map is a Chromium launch flag");
		await page.goto("/console/");
		expect(await page.evaluate(probe, `${API}/health`)).toBe("failed: TypeError");
	});

	test("a mocked request is still answered by the test's own route", async ({ page }) => {
		await page.route(`${API}/health`, (route) => route.fulfill({ status: 200, body: "ok" }));
		await page.goto("/console/");
		expect(await page.evaluate(probe, `${API}/health`)).toBe("reached (status 0)");
	});
});
