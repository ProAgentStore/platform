import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * #1088 — browser errors reach the durable log reliably, on every surface, against the bundles this run built.
 * Every API request is intercepted: `/v1/errors/client` is production's error log, and a run must never write
 * to it. The interception answers the way the platform does — including a 503 (not stored) — so what is
 * asserted is what the browser does with the answer: retry, replay after a reload, wait while offline.
 */
const API = "https://api.proagentstore.online";

type Report = { body: Record<string, unknown>; auth: string | undefined };

async function interceptApi(page: Page, answer: (n: number) => number = () => 200) {
	const reports: Report[] = [];
	await page.route(`${API}/**`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
	await page.route(`${API}/v1/errors/client`, async (route) => {
		reports.push({ body: JSON.parse(route.request().postData() || "{}"), auth: route.request().headers().authorization });
		const status = answer(reports.length);
		await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(status < 300 ? { ok: true, durable: true } : { ok: false, durable: false }) });
	});
	return reports;
}
const fire = (page: Page, message: string, filename?: string) =>
	page.evaluate(([m, f]) => window.dispatchEvent(new ErrorEvent("error", { message: m, error: new Error(m), ...(f ? { filename: f } : {}) })), [message, filename] as const);

test.describe("console: the SDK outbox (#1088)", () => {
	test("a pre-auth report the platform could not store is replayed after a reload — same id, still anonymous", async ({ page }) => {
		const reports = await interceptApi(page, (n) => (n === 1 ? 503 : 200));
		await page.goto("/console/");
		await fire(page, "e2e pre-auth probe");
		await expect.poll(() => reports.filter((r) => r.body.message === "Error: e2e pre-auth probe").length).toBe(1);
		const [first] = reports;
		expect(first.body.id).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
		expect(first.auth).toBeUndefined();

		// The 503 was not delivery: the event is still in the outbox, and the next page load sends it.
		await page.reload();
		await expect.poll(() => reports.filter((r) => r.body.id === first.body.id).length).toBe(2);
		expect(reports.find((r, i) => i > 0 && r.body.id === first.body.id)?.auth).toBeUndefined();
	});

	test("offline → online: nothing is sent while offline; the report goes once the browser is back", async ({ page, context }) => {
		const reports = await interceptApi(page);
		await page.goto("/console/");
		await context.setOffline(true);
		await fire(page, "e2e offline probe");
		await page.waitForTimeout(300);
		expect(reports.filter((r) => r.body.message === "Error: e2e offline probe")).toEqual([]);
		await context.setOffline(false);
		await expect.poll(() => reports.filter((r) => r.body.message === "Error: e2e offline probe").length).toBe(1);
	});
});

test.describe("public pages and the widget (#1088)", () => {
	test("a public page reports its own script errors — and not an extension's or another origin's", async ({ page }) => {
		const reports = await interceptApi(page);
		await page.goto("/about/");
		const origin = new URL(page.url()).origin;
		await fire(page, "e2e public probe", `${origin}/auth-widget.js`);
		await fire(page, "e2e foreign probe", "chrome-extension://abc/content.js");
		await expect.poll(() => reports.filter((r) => r.body.source === "public").length).toBe(1);
		const [r] = reports.filter((x) => x.body.source === "public");
		expect(r.body).toMatchObject({ message: "Error: e2e public probe", count: 1, context: expect.objectContaining({ page: "/about/", file: "/auth-widget.js" }) });
		expect(typeof r.body.id).toBe("string");
		expect(JSON.stringify(reports)).not.toContain("e2e foreign probe");
	});

	test("the embedded widget reports its own failure anonymously — even when the visitor is signed in", async ({ page }) => {
		const reports = await interceptApi(page);
		await page.route(`${API}/v1/public/agents/e2e-agent`, (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
		await page.goto("/about/");
		await page.evaluate(() => {
			localStorage.setItem("pags:session", "visitor-session-token");
			const s = document.createElement("script");
			s.src = "/widget.js";
			s.setAttribute("data-agent", "e2e-agent");
			document.body.appendChild(s);
		});
		await expect.poll(() => reports.filter((r) => r.body.source === "widget").length).toBe(1);
		const [w] = reports.filter((r) => r.body.source === "widget");
		expect(w.auth).toBeUndefined();
		expect(w.body).toMatchObject({ message: "agent load → 503", context: expect.objectContaining({ agent: "e2e-agent", status: 503 }) });
	});
});
