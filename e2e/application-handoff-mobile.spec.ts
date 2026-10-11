import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { expect, test } from "@playwright/test";

let vite: ChildProcess | undefined;
let fixtureBase = "";

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") return reject(new Error("No local test port"));
			server.close((error) => error ? reject(error) : resolve(address.port));
		});
	});
}

async function waitForFixture(url: string): Promise<void> {
	for (let i = 0; i < 80; i++) {
		try { if ((await fetch(url)).ok) return; } catch { /* Vite is still starting. */ }
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("The local mobile-handoff fixture did not start");
}

test.beforeAll(async () => {
	const port = await freePort();
	fixtureBase = `http://127.0.0.1:${port}`;
	vite = spawn("pnpm", ["exec", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
		cwd: "store/console", stdio: "ignore", detached: false,
	});
	await waitForFixture(`${fixtureBase}/console/handoff-mobile-fixture.html`);
});

test.afterAll(() => { vite?.kill("SIGTERM"); });

for (const [label, reconciliation] of [["live", false], ["reconciliation", true]] as const) {
	test(`mobile — ${label} handoff forwards ephemeral keyboard controls and ends cleanly`, async ({ page }) => {
		const relayed: Array<Record<string, unknown>> = [];
		const consoleMessages: string[] = [];
		let rejectInput = false;
		let expired = false;
		page.on("console", (message) => consoleMessages.push(message.text()));
		await page.setViewportSize({ width: 390, height: 844 });
		await page.route("**/v1/instances/instance-1/application-runs/run-1/**", async (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path.endsWith("/frame")) return route.fulfill({ status: expired ? 409 : 200, contentType: "application/json", body: JSON.stringify(expired ? { error: "handoff expired" } : { frame: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='480'%3E%3C/svg%3E", width: 320, height: 480 }) });
			if (path.endsWith("/input")) {
				const body = route.request().postDataJSON() as Record<string, unknown>;
				relayed.push(body);
				return route.fulfill({ status: rejectInput ? 409 : 200, contentType: "application/json", body: JSON.stringify(rejectInput ? { error: "handoff closed" } : { ok: true }) });
			}
			if (path.endsWith("/end")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ state: "ended" }) });
			return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "unexpected fixture route" }) });
		});
		await page.goto(`${fixtureBase}/console/handoff-mobile-fixture.html?reconciliation=${reconciliation ? "1" : "0"}`);
		const entry = page.getByTestId("application-handoff-mobile-text-entry");
		await expect(entry).toBeVisible();
		await expect(entry).toHaveAttribute("inputmode", "text");
		await entry.fill("mobile-code");
		await expect(entry).toHaveValue("");
		await page.getByRole("button", { name: "Continue" }).click();
		await page.getByRole("button", { name: "Delete" }).click();
		await expect.poll(() => relayed.length).toBeGreaterThanOrEqual(3);
		expect(relayed).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "text", text: "mobile-code" }),
			expect.objectContaining({ type: "key", key: "Enter" }),
			expect.objectContaining({ type: "key", key: "Backspace" }),
		]));
		// The component neither displays nor logs the typed value; only the mocked secure relay saw it.
		await expect(page.locator("body")).not.toContainText("mobile-code");
		await expect(page.getByRole("button", { name: /fill|upload|submit/i })).toHaveCount(0);

		rejectInput = true; // The mocked Runner's post-auth/read-only refusal.
		await entry.fill("after-auth");
		await expect(entry).toHaveValue("");
		await expect(page.getByText("Secure sign-in input is no longer available.")).toBeVisible();
		await expect(page.locator("body")).not.toContainText("after-auth");
		expect(consoleMessages.join("\n")).not.toContain("mobile-code");
		expect(consoleMessages.join("\n")).not.toContain("after-auth");

		expired = true;
		await expect(page.getByText("Live handoff unavailable")).toBeVisible();
		await page.getByRole("button", { name: "End" }).click();
		await expect(page.getByTestId("handoff-fixture-closed")).toBeVisible();
	});
}
