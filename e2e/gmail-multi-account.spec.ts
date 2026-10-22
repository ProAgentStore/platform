import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * #1281 — Preferences → Connections with the documented three-mailbox Gmail account: one read-only, one holding Send and reply, one
 * read-only. Every mailbox carries up to three "Allow" actions plus Disconnect.
 *
 * The defect (measured before the fix, Chromium): the per-mailbox row was one non-wrapping flex row whose buttons were `shrink-0`, so
 * from 320px to 640px the mailbox address was crushed to 10px wide (a 430–1,170px-tall column) and the buttons ran out to x=644 on a 320px
 * screen, making `<main>` 644px wide. At 1280px it fit, with the address squeezed to 159px. These tests measure each mailbox GROUP's
 * box and its controls' boxes, not only document overflow. `mobile — ` titles keep them in the WebKit project too.
 */
const API = "https://api.proagentstore.online";
const G = (id: string, label: string, held: boolean) => ({ id, label, held });
const GRANTS = (held: string[]) => [G("send", "Send and reply", held.includes("send")), G("archive", "Archive and mark read", held.includes("archive")), G("filters", "Create filters (each one approved by you)", held.includes("filters"))];
const GMAIL = {
	id: "gmail", label: "Gmail", auth: "oauth", grantModel: "user", configured: true, connected: true, account: "serge.the.dev@gmail.com", connectedAt: "2026-07-01T00:00:00Z", reach: null,
	flow: { start: "/v1/email/google/start", disconnect: "/v1/email/google" }, scopes: { read: true, write: true }, missingScopes: [],
	optionalGrants: GRANTS([]),
	accounts: [
		{ accountId: "a1", label: "serge.the.dev@gmail.com", connectedAt: "2026-07-01T00:00:00Z", missingScopes: [], optionalGrants: GRANTS([]) },
		{ accountId: "a2", label: "sivochkin@gmail.com", connectedAt: "2026-07-02T00:00:00Z", missingScopes: [], optionalGrants: GRANTS(["send"]) },
		{ accountId: "a3", label: "serge.pro.job@gmail.com", connectedAt: "2026-07-03T00:00:00Z", missingScopes: [], optionalGrants: GRANTS([]) },
	],
};
const OTHERS = [
	{ id: "google_drive", label: "Google Drive", auth: "oauth", grantModel: "instance-resource", configured: true, connected: false, account: null, connectedAt: null, reach: null, flow: { start: "/v1/drive/google/start", disconnect: "/v1/drive/google" } },
	{ id: "google_sheets", label: "Google Sheets", auth: "oauth", grantModel: "instance-resource", configured: true, connected: false, account: null, connectedAt: null, reach: null, flow: { start: "/v1/sheets/google/start", disconnect: "/v1/sheets/google" } },
];


type Cx = typeof GMAIL;
async function mock(page: Page, opts: { onStart?: (url: string) => void; onDelete?: (url: string) => void } = {}) {
	await page.addInitScript((t) => {
		window.localStorage.setItem("pags:session", t);
		// The sign-in opens another tab; the page only needs to believe it did.
		window.open = () => null;
	}, "test-pags-token");
	let gmail: Cx = JSON.parse(JSON.stringify(GMAIL));
	await page.route(`${API}/**`, async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user", "creator"], boardConfig: null, githubLinked: "serge-ivo" });
		if (path === "/v1/connectors") return json({ connectors: [gmail, ...OTHERS] });
		if (path === "/v1/email/google/start") {
			opts.onStart?.(req.url());
			return json({ url: "https://accounts.example.com/signin" });
		}
		if (path === "/v1/email/google" && req.method() === "DELETE") {
			opts.onDelete?.(req.url());
			const gone = new URL(req.url()).searchParams.get("account");
			gmail = { ...gmail, accounts: gmail.accounts.filter((a) => a.accountId !== gone) };
			return json({ ok: true });
		}
		if (path === "/v1/notifications") return json({ notifications: [], unreadCount: 0 });
		if (path === "/v1/instances/my/instances") return json({ instances: [] });
		if (path === "/v1/preferences") return json({ preferences: { voice: { speed: 130, sttMode: "openai" } }, languages: [{ name: "English", tag: "en-US" }] });
		return json({ error: "not mocked" }, 404);
	});
	return {
		/** The owner finished the sign-in in the other tab: mailbox a1 now holds Send and reply. */
		finishSignIn: () => {
			gmail = { ...gmail, accounts: gmail.accounts.map((a) => (a.accountId === "a1" ? { ...a, connectedAt: "2026-10-22T00:00:00Z", optionalGrants: GRANTS(["send"]) } : a)) };
		},
	};
}

const groups = (page: Page) => page.getByTestId("gmail-account-row");

test.describe("Preferences Connections with three Gmail mailboxes (#1281)", () => {
	for (const width of [320, 390, 640, 768, 1280]) {
		test(`mobile — each mailbox is a readable group with its controls inside it, and nothing overflows, at ${width}px`, async ({ page }) => {
			await mock(page);
			await page.setViewportSize({ width, height: 900 });
			await page.goto("/console/preferences");
			await expect(groups(page)).toHaveCount(3);

			// Mixed grant state: which actions each mailbox offers.
			const expected = [
				{ addr: "serge.the.dev@gmail.com", allow: ["Send and reply", "Archive and mark read", "Create filters"] },
				{ addr: "sivochkin@gmail.com", allow: ["Archive and mark read", "Create filters"] },
				{ addr: "serge.pro.job@gmail.com", allow: ["Send and reply", "Archive and mark read", "Create filters"] },
			];
			for (const [i, want] of expected.entries()) {
				const g = groups(page).nth(i);
				await expect(g).toContainText(want.addr);
				await expect(g.getByRole("button", { name: /^Allow:/ })).toHaveCount(want.allow.length);
				for (const label of want.allow) await expect(g.getByRole("button", { name: new RegExp(`^Allow: ${label}`) })).toBeVisible();
				await expect(g.getByRole("button", { name: `Disconnect ${want.addr}` })).toBeVisible();
			}
			await expect(groups(page).nth(1).getByRole("button", { name: /Allow: Send and reply/ })).toHaveCount(0);

			// Geometry: the control boxes, against their own group and the screen.
			const m = await page.evaluate(() => {
				const vw = document.documentElement.clientWidth;
				return {
					vw,
					doc: document.documentElement.scrollWidth,
					main: (document.querySelector("main") as HTMLElement).scrollWidth,
					groups: Array.from(document.querySelectorAll('[data-testid="gmail-account-row"]')).map((li) => {
						const r = li.getBoundingClientRect();
						const label = (li.firstElementChild as HTMLElement).getBoundingClientRect();
						return {
							name: (li.firstElementChild?.textContent ?? "").slice(0, 28),
							left: r.left, right: r.right, labelShare: (label.width / r.width) * 100, labelHeight: label.height,
							buttons: Array.from(li.querySelectorAll("button")).map((b) => { const br = b.getBoundingClientRect(); return { t: (b.textContent ?? "").slice(0, 20), left: br.left, right: br.right, width: br.width, height: br.height }; }),
						};
					}),
				};
			});
			expect(m.doc, "the page scrolls sideways").toBeLessThanOrEqual(m.vw);
			expect(m.main, "<main> is wider than the screen").toBeLessThanOrEqual(m.vw);
			for (const g of m.groups) {
				expect(g.right, `${g.name} runs off the screen`).toBeLessThanOrEqual(m.vw);
				expect(g.labelShare, `${g.name}'s address is crushed to ${Math.round(g.labelShare)}% of its group`).toBeGreaterThanOrEqual(90);
				expect(g.labelHeight, `${g.name}'s address runs ${Math.round(g.labelHeight)}px tall`).toBeLessThan(80);
				for (const b of g.buttons) {
					expect(b.left, `${b.t} starts left of its mailbox group`).toBeGreaterThanOrEqual(g.left);
					expect(b.right, `${b.t} ends past its mailbox group (${Math.round(b.right)} > ${Math.round(g.right)})`).toBeLessThanOrEqual(g.right);
					expect(b.height, `${b.t} is crushed`).toBeGreaterThan(8);
				}
			}
		});
	}

	test("mobile — the per-mailbox actions still act on THAT mailbox: grant, and disconnect only the one named", async ({ page }) => {
		const starts: string[] = [];
		const deletes: string[] = [];
		await mock(page, { onStart: (u) => starts.push(u), onDelete: (u) => deletes.push(u) });
		await page.setViewportSize({ width: 390, height: 900 });
		await page.goto("/console/preferences");
		await groups(page).nth(1).getByRole("button", { name: /Allow: Create filters/ }).click();
		await expect.poll(() => starts.at(-1)).toContain("grant=filters");
		expect(starts.at(-1)).toContain("account=a2");

		page.once("dialog", (d) => void d.accept());
		await groups(page).nth(1).getByRole("button", { name: "Disconnect sivochkin@gmail.com" }).click();
		await expect.poll(() => deletes.at(-1)).toContain("account=a2");
		await expect(groups(page)).toHaveCount(2);
		await expect(page.getByText("sivochkin@gmail.com disconnected.")).toBeVisible();
	});

	test("mobile — the sign-in instruction is replaced once the sign-in has changed the connection, and kept while it has not", async ({ page }) => {
		const { finishSignIn } = await mock(page);
		await page.setViewportSize({ width: 390, height: 900 });
		await page.goto("/console/preferences");
		const instruction = page.getByText("Complete the Gmail sign-in in the new tab");
		await groups(page).nth(0).getByRole("button", { name: /Allow: Send and reply/ }).click();
		await expect(instruction).toBeVisible();

		// Back on the tab with nothing changed: still waiting, so the instruction stays true.
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await page.waitForTimeout(300);
		await expect(instruction).toBeVisible();

		// The sign-in finished in the other tab.
		finishSignIn();
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await expect(page.getByText("Gmail connection updated.")).toBeVisible();
		await expect(instruction).toHaveCount(0);
		// and the page shows the new state: that mailbox no longer offers Send and reply.
		await expect(groups(page).nth(0).getByRole("button", { name: /Allow: Send and reply/ })).toHaveCount(0);
	});
});
