/**
 * The browser verification and takeover MCP tools (#1031) send the console's own requests to the console's
 * own routes — which is what makes "UI and MCP expose the same settings/state" true by construction. These
 * run the real handlers against a stubbed fetch, so what is asserted is the request that leaves MCP.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerBrowserVerificationTools } from "./browser-verification.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

function tools(reply: unknown = { ok: true }) {
	const seen: Array<{ url: string; method: string; body: unknown }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		seen.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
		return new Response(JSON.stringify(reply), { status: 200, headers: { "Content-Type": "application/json" } });
	});
	const handlers = new Map<string, Handler>();
	const env: McpEnv = { API_BASE: "https://api.test" };
	registerBrowserVerificationTools({ tool: (name: string, _d: string, _s: unknown, h: Handler) => handlers.set(name, h) } as never, {
		env,
		tokenFor: (p?: string) => p || "session-token",
		safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: ["read", "write", "runtime"] }),
	} as never);
	return { seen, call: (name: string, args: Record<string, unknown>) => (handlers.get(name) as Handler)(args).then((r) => r.content[0].text) };
}

afterEach(() => vi.unstubAllGlobals());

const BV = "https://api.test/v1/instances/i1/browser-verification";
const TAKEOVERS = "https://api.test/v1/instances/i1/browser-takeovers";

describe("set_instance_browser_verification (#1031)", () => {
	it("maps every snake_case field to the camelCase body the console sends, and nothing else", async () => {
		const { seen, call } = tools();
		await call("set_instance_browser_verification", { instance_id: "i1", enabled: true, runtime: "any_eligible", fallback: "wait", wait_limit_minutes: 45, takeover: "prompt", allow_mobile: false });
		expect(seen).toEqual([{ url: BV, method: "PUT", body: { enabled: true, runtime: "any_eligible", fallback: "wait", waitLimitMinutes: 45, takeover: "prompt", allowMobile: false } }]);
	});

	it("sends only the fields passed — patch semantics, like the console's changedFields", async () => {
		const { seen, call } = tools();
		await call("set_instance_browser_verification", { instance_id: "i1", allow_mobile: true });
		expect(seen).toEqual([{ url: BV, method: "PUT", body: { allowMobile: true } }]);
	});

	it("a dry run sends nothing and says what it would change", async () => {
		const { seen, call } = tools();
		const out = await call("set_instance_browser_verification", { instance_id: "i1", wait_limit_minutes: 30, allow_mobile: false, dry_run: true });
		expect(seen).toEqual([]);
		expect(out).toMatch(/waitLimitMinutes/);
		expect(out).toMatch(/allowMobile/);
		expect(out).toContain("/v1/instances/i1/browser-verification");
	});

	it("refuses an empty change without calling the API", async () => {
		const { seen, call } = tools();
		expect(await call("set_instance_browser_verification", { instance_id: "i1" })).toMatch(/pass at least one setting/);
		expect(seen).toEqual([]);
	});
});

describe("the read tools call the console's routes and return their bodies unchanged (#1031)", () => {
	it("get_instance_browser_verification and list_eligible_browser_runtimes", async () => {
		const view = { settings: { enabled: false }, capability: { declared: true, engine: "claude" }, runnerNode: null, notificationEvents: ["takeover_required"] };
		const { seen, call } = tools(view);
		expect(JSON.parse(await call("get_instance_browser_verification", { instance_id: "i1" }))).toEqual(view);
		await call("list_eligible_browser_runtimes", { instance_id: "i1" });
		expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([`GET ${BV}`, `GET ${BV}/runtimes`]);
	});

	it("browser_takeover_list passes its filters as the route's query, and returns the takeovers", async () => {
		const listed = { takeovers: [{ id: "t1", subjectKind: "local_browser_run", subjectId: "run-1", state: "requested" }] };
		const { seen, call } = tools(listed);
		expect(JSON.parse(await call("browser_takeover_list", { instance_id: "i1", state: "requested", subject_kind: "local_browser_run", subject_id: "run-1", limit: 5 }))).toEqual(listed);
		await call("browser_takeover_list", { instance_id: "i1" });
		expect(seen.map((s) => s.url)).toEqual([`${TAKEOVERS}?state=requested&subject_kind=local_browser_run&subject_id=run-1&limit=5`, TAKEOVERS]);
	});

	it("browser_takeover_get reads one takeover by id", async () => {
		const one = { takeover: { id: "t 1", state: "active" } };
		const { seen, call } = tools(one);
		expect(JSON.parse(await call("browser_takeover_get", { instance_id: "i1", takeover_id: "t 1" }))).toEqual(one);
		expect(seen).toEqual([{ url: `${TAKEOVERS}/t%201`, method: "GET", body: undefined }]);
	});
});

describe("the takeover writes (#1031)", () => {
	it("browser_takeover_transition sends the console banner's PATCH, device included", async () => {
		const { seen, call } = tools({ takeover: { id: "t1", state: "resumed" }, changed: true });
		await call("browser_takeover_transition", { instance_id: "i1", takeover_id: "t1", state: "resumed", device: "mobile" });
		await call("browser_takeover_transition", { instance_id: "i1", takeover_id: "t1", state: "ended" });
		expect(seen).toEqual([
			{ url: `${TAKEOVERS}/t1`, method: "PATCH", body: { state: "resumed", device: "mobile" } },
			{ url: `${TAKEOVERS}/t1`, method: "PATCH", body: { state: "ended" } },
		]);
	});

	it("dry runs of a transition and a request send nothing", async () => {
		const { seen, call } = tools();
		expect(await call("browser_takeover_transition", { instance_id: "i1", takeover_id: "t1", state: "active", dry_run: true })).toContain("/browser-takeovers/t1");
		expect(await call("browser_takeover_request", { instance_id: "i1", subject_kind: "runtime_task", subject_id: "task-1", dry_run: true })).toContain("/browser-takeovers");
		expect(seen).toEqual([]);
	});

	it("browser_takeover_request posts the subject and reason", async () => {
		const { seen, call } = tools({ created: true, takeover: { id: "t2", state: "requested" } });
		await call("browser_takeover_request", { instance_id: "i1", subject_kind: "runtime_task", subject_id: "task-1", reason: "login_required" });
		expect(seen).toEqual([{ url: TAKEOVERS, method: "POST", body: { subjectKind: "runtime_task", subjectId: "task-1", reason: "login_required" } }]);
	});
});
