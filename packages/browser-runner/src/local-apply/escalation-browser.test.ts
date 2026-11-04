import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { McpRuntime } from "../mcp-runtime.js";
import { projectPreferenceSources } from "../instance-preferences.js";
import { ApplyBridge, type ApplyBridgeHost, type ToolResult } from "./bridge.js";
import { sourceId } from "./answer-decision.js";
import { parseLocalApplyEvent, type LocalApplyEvent, type LocalApplySupervisorCheckpoint } from "./contract.js";
import { redactReplayText } from "./apply-replay.js";

const SOURCE = { label: "profile", text: "Name: Jane Citizen\nLocation: Melbourne\nWork arrangement: full time" };
const body = `<h1>Independent form controls</h1>
<label>Nom complet<input id="name"></label>
<label>Arbeitsmodell<select id="arrangement"><option value="">Choose</option><option value="FT">Full-time</option></select></label>
<div role="listbox" aria-label="Office"><div role="option" tabindex="0" onclick="document.querySelector('#city').value='Melbourne (VIC)'">Melbourne (VIC)</div></div>
<input id="city" aria-label="Chosen office" readonly>
<form method="post" onsubmit="event.preventDefault();window.sent=true"><button>Submit application</button></form>`;
const message = (result: ToolResult) => result.content.map((block) => block.type === "text" ? block.text : "").join("\n");

describe("configured model discretion through the real Playwright bridge", () => {
	let browser: Browser, context: BrowserContext, page: Page, runtime: McpRuntime, bridge: ApplyBridge, host: ApplyBridgeHost;
	let stopped: boolean, allowed: boolean;
	let checkpoints: LocalApplySupervisorCheckpoint[];
	let events: Array<Omit<LocalApplyEvent, "at">>;
	const pauses = vi.fn(async () => "stopped" as const);
	beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
	beforeEach(async () => {
		context = await browser.newContext(); page = await context.newPage(); runtime = new McpRuntime();
		await runtime.start({ context, activePage: () => page });
		stopped = false; allowed = true; checkpoints = []; events = []; pauses.mockClear();
		host = {
			emit: (event) => events.push(event), pause: pauses, supervisorCheckpoint: async (checkpoint) => { checkpoints.push(checkpoint); return "continue"; },
			isAllowed: (domain) => allowed && domain === "discretion.test", grounding: () => SOURCE.text, groundingSources: () => [SOURCE],
			artifactPath: () => ({ error: "No fixture artifacts" }), overTime: () => false, isStopped: () => stopped, now: Date.now,
			limits: { maxMinutes: 20, maxPages: 30, maxActions: 300 }, mode: "fill_and_review", escalationLevel: "balanced",
		};
		runtime.setCallPolicy({ isCancelled: () => stopped, isDomainAllowed: host.isAllowed });
		bridge = new ApplyBridge(runtime, host);
		await context.route("https://**/*", (route) => route.fulfill({ contentType: "text/html", body }));
		await bridge.callTool("browser_navigate", { url: "https://discretion.test/form" });
		await snapshot();
		await bridge.callTool("supervisor_checkpoint", { checkpointId: "initial", phase: "initial" });
	});
	afterEach(async () => { await runtime.stop(); await context.close(); });
	afterAll(async () => { await browser.close(); });
	async function snapshot() { return message(await bridge.callTool("browser_snapshot")); }
	async function ref(role: string, label: string) {
		const line = (await snapshot()).split("\n").find((line) => line.includes(`${role} "${label}"`));
		const target = line?.match(/\[ref=([^\]]+)\]/)?.[1];
		if (!target) throw new Error(`Missing ${role} ${label}: ${line}`);
		return target;
	}
	function assessment(risk: "minor" | "major" = "minor") { return { risk, reason: "Faithful source-supported expression in the observed control", sourceId: sourceId(SOURCE), sourceStatus: "supported" }; }
	async function fill(kind: "text" | "select" | "option", risk: "minor" | "major") {
		if (kind === "text") return bridge.callTool("browser_type", { target: await ref("textbox", "Nom complet"), text: "Citizen, Jane", source_quote: "Name: Jane Citizen", decision: assessment(risk) });
		if (kind === "select") return bridge.callTool("browser_select_option", { target: await ref("combobox", "Arbeitsmodell"), values: ["FT"], source_quote: "Work arrangement: full time", decision: assessment(risk) });
		return bridge.callTool("browser_click", { target: await ref("option", "Melbourne (VIC)"), source_quote: "Location: Melbourne", decision: assessment(risk) });
	}
	const cases = (["text", "select", "option"] as const).flatMap((kind) => (["conservative", "balanced", "autonomous"] as const).flatMap((level) => (["minor", "major"] as const).map((risk) => ({ kind, level, risk, allowed: level === "autonomous" || level === "balanced" && risk === "minor" }))));
	it.each(cases)("$level $risk decision on $kind: allowed=$allowed", async ({ kind, level, risk, allowed }) => {
		host.escalationLevel = level;
		const result = await fill(kind, risk);
		expect(!result.isError, message(result)).toBe(allowed);
		expect(await page.locator(kind === "text" ? "#name" : kind === "select" ? "#arrangement" : "#city").inputValue()).toBe(allowed ? kind === "text" ? "Citizen, Jane" : kind === "select" ? "FT" : "Melbourne (VIC)" : "");
	});
	it("uses current instance memory without English field classification", async () => {
		const preferences = { version: 1 as const, source: "user" as const, instanceId: "fixture", memoryKey: "job_application_preferences" as const, memoryUpdatedAt: new Date().toISOString(), sha256: "a".repeat(64), facts: [{ field: "employment_type" as const, answer: "Full-time", confirmedAt: new Date().toISOString() }] };
		const sources = projectPreferenceSources([SOURCE], preferences);
		host.groundingSources = () => sources; host.instancePreferences = () => preferences;
		const source = sources.at(-1)!;
		const result = await bridge.callTool("browser_select_option", { target: await ref("combobox", "Arbeitsmodell"), values: ["FT"], source_quote: '"answer": "Full-time"', decision: { ...assessment(), sourceId: sourceId(source) } });
		expect(result.isError, message(result)).not.toBe(true);
		expect(await page.locator("#arrangement").inputValue()).toBe("FT");
	});
	it.each(["missing", "ambiguous", "conflicting", "forged_id", "forged_quote", "stale_id"])("refuses unsupported attribution: %s", async (failure) => {
		host.escalationLevel = "autonomous";
		const target = await ref("textbox", "Nom complet");
		const decision = { ...assessment(), ...(failure === "forged_id" ? { sourceId: "page-source" } : ["missing", "ambiguous", "conflicting"].includes(failure) ? { sourceStatus: failure } : {}) };
		if (failure === "stale_id") host.groundingSources = () => [{ ...SOURCE, text: "Updated owner facts" }];
		const result = await bridge.callTool("browser_type", { target, text: "Citizen, Jane", source_quote: failure === "forged_quote" ? "Name: Someone else" : "Name: Jane Citizen", decision });
		expect(result.isError).toBe(true); expect(await page.locator("#name").inputValue()).toBe("");
	});
	it.each(["stop", "origin", "stale_ref"])("delegation cannot bypass %s", async (guard) => {
		const target = await ref("textbox", "Nom complet"); host.escalationLevel = "autonomous";
		if (guard === "stop") stopped = true;
		if (guard === "origin") allowed = false;
		if (guard === "stale_ref") { await page.locator("#name").evaluate((el) => el.remove()); await snapshot(); }
		const result = await bridge.callTool("browser_type", { target, text: "Citizen, Jane", source_quote: "Name: Jane Citizen", decision: assessment() });
		expect(result.isError, message(result)).toBe(true); expect(bridge.filled).toBe(0);
	});
	it("rejects invalid uncertainty locally and forwards a valid assessment", async () => {
		host.escalationLevel = "autonomous";
		const result = await bridge.callTool("supervisor_checkpoint", { checkpointId: "unknown", phase: "uncertain" });
		expect(result.isError).toBe(true); expect(checkpoints).toHaveLength(1);
		expect((await fill("text", "minor")).isError).not.toBe(true);
		await bridge.callTool("supervisor_checkpoint", { checkpointId: "choice", phase: "uncertain", decision: { risk: "major", reason: "Material source interpretation" } });
		expect(checkpoints.at(-1)?.facts.decision).toEqual({ risk: "major", reason: "Material source interpretation" });
	});
	it("retains model risk and source receipts while redacting known secrets before transport", async () => {
		const secret = "test-vault-password-keep-private";
		host.redact = (text) => redactReplayText(text, [secret, "1234"]);
		const decision = { ...assessment(), reason: `Equivalent source expression; never retain ${secret}` };
		const result = await bridge.callTool("browser_type", { target: await ref("textbox", "Nom complet"), text: "Citizen, Jane", source_quote: "Name: Jane Citizen", decision });
		expect(result.isError).not.toBe(true);
		const event = events.find((event) => event.detail?.decisionRisk === "minor")!;
		const receipt = parseLocalApplyEvent({ ...event, at: new Date().toISOString() });
		expect(receipt?.detail).toMatchObject({ escalationLevel: "balanced", decisionRisk: "minor", decisionReason: "Equivalent source expression; never retain [REDACTED]", sourceId: sourceId(SOURCE) });
		expect(JSON.stringify(events)).not.toContain(secret);
		await bridge.callTool("supervisor_checkpoint", { checkpointId: "redacted-assessment", phase: "uncertain", decision: { risk: "minor", reason: decision.reason } });
		expect(checkpoints.at(-1)?.facts.decision?.reason).toContain("[REDACTED]");
		expect(JSON.stringify(checkpoints)).not.toContain(secret);
		await bridge.callTool("supervisor_checkpoint", { checkpointId: "expanded-redaction", phase: "uncertain", decision: { risk: "minor", reason: "1234 ".repeat(200).trim() } });
		expect(checkpoints.at(-1)?.facts.decision?.reason.length).toBeLessThanOrEqual(1000);
		expect(checkpoints.at(-1)?.facts.decision?.reason).toContain("explanation omitted");
		expect(checkpoints.at(-1)?.facts.decision?.reason).not.toContain("1234");
	});

	it("autonomous missing facts do not pause independent work or masquerade as completion", async () => {
		host.escalationLevel = "autonomous"; host.mode = "auto_submit"; host.gateId = "authorized-fixture";
		expect((await bridge.callTool("request_answer", { question: "What is your professional registration number?" })).isError).not.toBe(true);
		expect(pauses).not.toHaveBeenCalled(); expect(bridge.unresolvedQuestions).toHaveLength(1);
		expect((await fill("text", "minor")).isError).not.toBe(true);
		const target = await ref("button", "Submit application");
		expect((await bridge.callTool("browser_click", { target })).isError).toBe(true);
		expect(await page.evaluate(() => (window as unknown as { sent?: boolean }).sent)).not.toBe(true);
		await bridge.callTool("ready_for_review", { summary: "Known fields completed" });
		expect(bridge.reviewReady).toBe(false); expect(bridge.blocked).toEqual({ reason: "incomplete", questions: ["What is your professional registration number?"] });
		expect(bridge.summary).toContain("Incomplete");
	});
	it("autonomy does not authorize final submission in fill-only mode", async () => {
		host.escalationLevel = "autonomous"; await fill("text", "major");
		const target = await ref("button", "Submit application");
		await bridge.callTool("browser_click", { target, decision: assessment("major") });
		expect(bridge.submitAttempted).toBe(false);
		expect(await page.evaluate(() => (window as unknown as { sent?: boolean }).sent)).not.toBe(true);
	});
});
