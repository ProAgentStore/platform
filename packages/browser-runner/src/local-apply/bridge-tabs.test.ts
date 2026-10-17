/**
 * #1133: SEEK's "Apply" opened its sign-in in a NEW TAB, and the run ended `review.ready` count 0.
 *
 * Three live fills (abb37433, 7a923d6f, f63b2963 — the last on runner 0.4.145, after #1100 shipped) each
 * summarised "Clicking Apply opened a SEEK Candidate Sign In tab". #1100's sign-in checks never fired
 * because they read the CURRENT tab, and Playwright MCP keeps the current tab where it was when a popup
 * opens (`_onPageCreated` only sets `_currentTab` when there is none). #1100's own test pushed the sign-in
 * onto the one tab its fake browser has — the opposite of what the real browser does.
 *
 * This fake models tabs the way Playwright MCP does: a click can open a tab, the new tab is NOT current,
 * `browser_tabs` lists and selects, and every page check evaluates the current tab only.
 */
import { describe, expect, it } from "vitest";
import type { BrowserTools } from "../local-browser/bridge.js";
import { ApplyBridge, type ApplyBridgeHost } from "./bridge.js";
import type { LocalApplyEvent, LocalApplyPause } from "./contract.js";

const JOB = "https://au.seek.com/job/95035981";
const SIGN_IN = "https://login.seek.com/login";
const FORM = "https://au.seek.com/job/95035981/apply";
const AD = '- link "Apply" [ref=e20]';
const FORM_SNAPSHOT = '- textbox "Full name" [ref=e1]';

function tabbedBrowser(o: { ownerTabs?: string[]; popups?: Record<string, string>; duplicateListing?: boolean } = {}) {
	const tabs = [...(o.ownerTabs ?? []), "about:blank"];
	let current = tabs.length - 1;
	const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	const list = () => tabs.map((u, i) => `- ${i}:${i === current ? " (current)" : ""} [page](${u})`).join("\n");
	const tools: BrowserTools = {
		listTools: async () => [],
		callTool: async (name, args = {}) => {
			if (name === "browser_evaluate") {
				if (typeof args.target === "string") return { content: [{ text: `### Result\n${JSON.stringify({ tag: "a", type: "", submits: false, method: "", name: "Apply" })}` }] };
				return { content: [{ text: `### Result\n${JSON.stringify({ url: tabs[current], title: "SEEK" })}` }] };
			}
			calls.push({ name, args });
			if (name === "browser_navigate") tabs[current] = String(args.url);
			if (name === "browser_click" && o.popups?.[String(args.target)]) tabs.push(o.popups[String(args.target)]); // opened, NOT selected
			if (name === "browser_tabs" && args.action === "select") current = Number(args.index);
			if (name === "browser_tabs") return { content: [{ text: `### Result\n${list()}${o.duplicateListing ? `\n### Open tabs\n${list()}` : ""}` }] };
			if (name === "browser_snapshot") return { content: [{ text: tabs[current] === FORM ? FORM_SNAPSHOT : AD }] };
			return { content: [{ text: `${name} ok` }] };
		},
	};
	return { tools, calls, tabs, current: () => tabs[current], go: (url: string) => (tabs[current] = url) };
}

function host(resume?: (p: LocalApplyPause) => "resumed" | "stopped") {
	const events: Array<Omit<LocalApplyEvent, "at">> = [];
	const pauses: LocalApplyPause[] = [];
	const allow = ["au.seek.com", "seek.com"];
	const h: ApplyBridgeHost = {
		emit: (e) => events.push(e),
		pause: async (p) => {
			pauses.push(p);
			return resume ? resume(p) : "stopped";
		},
		supervisorCheckpoint: async () => "continue",
		isAllowed: (d) => allow.some((a) => d === a || d.endsWith(`.${a}`)),
		grounding: () => "Name: Jane Citizen",
		artifactPath: (kind) => ({ path: `/home/jane/jobs/${kind}.md`, sha256: "a".repeat(64) }),
		overTime: () => false,
		now: () => Date.parse("2026-10-17T01:00:00Z"),
		limits: { maxMinutes: 20, maxPages: 30, maxActions: 300 },
		mode: "auto_submit",
		gateId: "gate-1",
	};
	return { h, events, pauses };
}

async function onAd(b: ReturnType<typeof tabbedBrowser>, hh: ReturnType<typeof host>) {
	const bridge = new ApplyBridge(b.tools, hh.h);
	await bridge.callTool("browser_navigate", { url: JOB });
	await bridge.callTool("browser_snapshot", {});
	await bridge.callTool("supervisor_checkpoint", { checkpointId: "seek-95035981-initial", phase: "initial" });
	return bridge;
}

describe("a click that opens a new tab is followed, so the run sees where it led (#1133)", () => {
	it("run f63b2963: Apply opens SEEK's sign-in in a new tab — the run pauses login_required instead of reviewing an empty form", async () => {
		const b = tabbedBrowser({ popups: { e20: SIGN_IN } });
		const hh = host();
		const bridge = await onAd(b, hh);
		const click = await bridge.callTool("browser_click", { target: "e20" });

		expect(b.current()).toBe(SIGN_IN);
		expect(hh.events).toContainEqual({ type: "policy.decision", detail: { tool: "browser_click", class: "read", decision: "followed", reason: "opened_new_tab" } });
		expect(hh.pauses).toEqual([expect.objectContaining({ reason: "login_required", url: SIGN_IN, domain: "login.seek.com" })]);
		expect(click.isError).toBe(true); // the owner did not sign in: "Stop now."
		// What the CLI did next in the live run. Not a review of nothing — the recorded sign-in.
		const review = await bridge.callTool("ready_for_review", { summary: "Blocked at sign-in" });
		expect(review.isError).toBe(true);
		expect(bridge.reviewReady).toBe(false);
		expect(bridge.blocked).toMatchObject({ reason: "login_required" });
		expect(hh.events.some((e) => e.type === "review.ready")).toBe(false);
	});

	it("when the owner signs in at that pause, the run carries on in the new tab and fills the form", async () => {
		const b = tabbedBrowser({ popups: { e20: SIGN_IN } });
		const hh = host(() => {
			b.go(FORM); // signed in: SEEK sends the sign-in tab on to the application form
			return "resumed";
		});
		const bridge = await onAd(b, hh);
		expect((await bridge.callTool("browser_click", { target: "e20" })).isError).toBeFalsy();
		await bridge.callTool("browser_snapshot", {});
		await bridge.callTool("supervisor_checkpoint", { checkpointId: "seek-95035981-form", phase: "post_navigation" });
		const typed = await bridge.callTool("browser_type", { target: "e1", text: "Jane Citizen", source_quote: "Name: Jane Citizen" });
		expect(typed.isError).toBeFalsy();
		expect(await bridge.callTool("ready_for_review", { summary: "Filled" })).toMatchObject({ content: [{ text: expect.stringMatching(/waits for the owner's review/) }] });
		expect(hh.events.find((e) => e.type === "review.ready")).toEqual({ type: "review.ready", detail: { class: "review", count: 1 } });
	});

	it("never selects a tab that was already open — the profile is the owner's own browser", async () => {
		const b = tabbedBrowser({ ownerTabs: ["https://mail.example.com/inbox", "https://bank.example.com"] });
		const hh = host();
		const bridge = await onAd(b, hh);
		await bridge.callTool("browser_click", { target: "e20" }); // opens no tab
		expect(b.calls.some((c) => c.name === "browser_tabs" && c.args.action === "select")).toBe(false);
		expect(b.current()).toBe(JOB);
	});

	it("counts tabs from the Result section only, though Playwright MCP may repeat the list under Open tabs", async () => {
		const b = tabbedBrowser({ popups: { e20: SIGN_IN }, duplicateListing: true });
		const hh = host();
		const bridge = await onAd(b, hh);
		await bridge.callTool("browser_click", { target: "e20" });
		expect(b.calls.filter((c) => c.name === "browser_tabs" && c.args.action === "select")).toEqual([{ name: "browser_tabs", args: { action: "select", index: 1 } }]);
		expect(b.current()).toBe(SIGN_IN);
	});
});
