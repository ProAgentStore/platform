/** Durable browser takeovers in the console (#1031): the banner's sentences, the mobile gate, and MCP parity. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type BrowserTakeover, remoteViewBlocked, takeoverLine } from "./browserTakeovers";

const t = (over: Partial<BrowserTakeover> = {}): BrowserTakeover => ({
	id: "t1",
	subjectKind: "runtime_task",
	subjectId: "task-1",
	state: "requested",
	reason: "captcha",
	mobileAllowed: true,
	endReason: null,
	expiresAt: new Date(10 * 60_000).toISOString(),
	createdAt: new Date(0).toISOString(),
	activatedAt: null,
	endedAt: null,
	...over,
});

describe("takeover banner (#1031)", () => {
	it("says what is waiting, why, and until when", () => {
		expect(takeoverLine(t(), 0)).toEqual({ text: "Waiting for you to take over (captcha) — the request expires in 10 min.", tone: "warn" });
		expect(takeoverLine(t({ state: "resumed", endReason: "resumed_at_machine" })).text).toBe("Handed back to the run: it was resumed at the machine.");
		expect(takeoverLine(t({ state: "expired", endReason: "expired" }))).toEqual({ text: "The takeover request expired: nobody took over in time.", tone: "muted" });
	});

	it("blocks the remote view from a phone only when the owner turned mobile off, and never for a closed one", () => {
		expect(remoteViewBlocked(t(), "mobile")).toBeNull();
		expect(remoteViewBlocked(t({ mobileAllowed: false }), "mobile")).toMatch(/from a phone is off/);
		expect(remoteViewBlocked(t({ mobileAllowed: false }), "desktop")).toBeNull();
		expect(remoteViewBlocked(t({ state: "ended" }), "desktop")).toBe("This takeover is closed.");
	});

	// UI/MCP parity: the console reads and moves takeovers through the routes MCP's tools call.
	it("reads and moves takeovers through the same routes and moves as MCP", () => {
		const mcp = readFileSync(join(__dirname, "../../../../workers/mcp/src/instance-tools/browser-verification.ts"), "utf8");
		const banner = readFileSync(join(__dirname, "../components/TakeoverBanner.tsx"), "utf8");
		const card = readFileSync(join(__dirname, "../tabs/settings/BrowserVerificationSection.tsx"), "utf8");
		expect(mcp).toContain("/browser-takeovers`");
		expect(banner).toContain("/browser-takeovers?subject_kind=");
		expect(card).toContain("/browser-takeovers?limit=");
		// The two moves the console makes are moves the transition tool offers.
		for (const move of ["resumed", "ended"]) {
			expect(mcp).toMatch(new RegExp(`state: z\\.enum\\(\\[[^\\]]*"${move}"`));
			expect(`${banner}${card}`).toContain(`"${move}"`);
		}
		// The remote view tells the server where it is, so the mobile preference is enforced there too.
		expect(readFileSync(join(__dirname, "../pages/RunDetail.tsx"), "utf8")).toMatch(/frame\?device=\$\{deviceKind\(\)\}/);
	});
});
