/**
 * The eval runner (#1244): a real `PagsMcp` behind a real MCP `Client`, the platform API stubbed per task, every request recorded.
 *
 * The harness imports nothing from the server itself. The caller hands in `PagsMcp`, `Client` and `InMemoryTransport`, because the
 * server's base class (`agents/mcp`) only loads under a module mock outside a Worker — the mock lives in the test or run file, not
 * here. That also lets the same harness run, unchanged, against an older checkout of the server for a before/after comparison.
 *
 * It replaces `globalThis.fetch` for the length of a run (the server reaches the API through it) and puts it back after.
 */
import type { EvalDriver, EvalTool, ToolCall } from "./driver.js";
import { type CallOutcome, type CallScore, type Effect, type Outcome, type Recorded, scoreCall, summarize, type Totals } from "./scorer.js";

export interface McpHost {
	// biome-ignore lint/suspicious/noExplicitAny: the mocked-base subclass is constructed by the caller
	PagsMcp: any;
	// biome-ignore lint/suspicious/noExplicitAny: SDK client class, passed in so this file imports nothing
	Client: any;
	// biome-ignore lint/suspicious/noExplicitAny: SDK in-memory transport, as above
	InMemoryTransport: any;
}

/** One stubbed API answer. The first stub whose `when` matches wins; no match is a plain 200 `{ success: true }`. */
export interface ApiStub {
	when: (req: Recorded) => boolean;
	status?: number;
	body: unknown;
}

export interface Variant {
	/** `clean` is the call a careful caller makes; any other label names a mistake observed (or likely) in practice. */
	label: string;
	call: ToolCall;
	/** What this mistake should come to on the CURRENT server — the corpus checks itself against it. */
	expect: Outcome;
}

export interface EvalTask {
	id: string;
	/** Rows of docs/mcp-tool-audit.md §6 this task exercises. */
	offenders: number[];
	/** What the owner says — owner-shaped, not tool-shaped. */
	prompt: string;
	expectedTool: string;
	/** The request that proves the task was done. `null` = the tool answers without calling the API. */
	effect: Effect | null;
	clean: ToolCall;
	/** Plausible wrong first calls: the mistakes the audit found, replayed. */
	sloppy: Variant[];
	stubs?: ApiStub[];
	/** Why this task is here, and what each variant stands for. */
	notes: string;
}

export interface TaskResult {
	taskId: string;
	variant: string;
	driver: string;
	call: ToolCall | null;
	score: CallScore;
	texts: string[];
	/** The API requests the server made for this call, in order. */
	requests: Recorded[];
}

const ROSTER = { instances: [{ id: "inst-1", capabilities: { surfaces: ["coding", "apply", "repo"] } }] };

export interface Session {
	tools: EvalTool[];
	run(task: EvalTask, call: ToolCall | null): Promise<{ outcome: CallOutcome | null }>;
	close(): void;
}

/** Start the server once, connect a client, and return a session that runs one task call at a time. */
export async function openSession(host: McpHost): Promise<Session> {
	const realFetch = globalThis.fetch;
	let recorded: Recorded[] = [];
	let stubs: ApiStub[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
		const req: Recorded = { method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, body: (init?.body as string | undefined) ?? null };
		recorded.push(req);
		if (req.path.startsWith("/v1/instances/my/instances")) return Response.json(ROSTER);
		const stub = stubs.find((s) => s.when(req));
		return Response.json(stub ? stub.body : { success: true }, { status: stub?.status ?? 200 });
	}) as typeof fetch;

	try {
		const inst = new host.PagsMcp();
		const kv = new Map<string, string>();
		inst.env = {
			API_BASE: "https://api.test",
			OAUTH_KV: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v), delete: async (k: string) => void kv.delete(k), list: async () => ({ keys: [], list_complete: true }) },
			GITHUB_ORG: "ProAgentStore",
		};
		inst.props = { authToken: "session-token", mcpScopes: ["read", "write", "runtime", "destructive"], mcpSubject: "user-1" };
		await inst.init();
		const [clientTransport, serverTransport] = host.InMemoryTransport.createLinkedPair();
		const client = new host.Client({ name: "pags-eval", version: "0.0.0" });
		await Promise.all([client.connect(clientTransport), inst.server.connect(serverTransport)]);
		const listed = (await client.listTools()) as { tools: EvalTool[] };
		return {
			tools: listed.tools,
			async run(task, call) {
				recorded = [];
				stubs = task.stubs ?? [];
				if (!call) return { outcome: null };
				const r = (await client.callTool({ name: call.name, arguments: call.args })) as { isError?: boolean; content: Array<{ text?: string }> };
				return { outcome: { isError: r.isError === true, texts: r.content.map((c) => c.text ?? ""), requests: [...recorded] } };
			},
			close() {
				globalThis.fetch = realFetch;
			},
		};
	} catch (e) {
		globalThis.fetch = realFetch;
		throw e;
	}
}

/** Ask the driver for the first call of one task, make it, and score it. */
export async function runOne(session: Session, task: EvalTask, driver: EvalDriver, variant: string): Promise<TaskResult> {
	const call = await driver.chooseToolCall(task.prompt, session.tools);
	const { outcome } = await session.run(task, call);
	return { taskId: task.id, variant, driver: driver.label, call, score: scoreCall({ tool: task.expectedTool, effect: task.effect }, call, outcome), texts: outcome?.texts ?? [], requests: outcome?.requests ?? [] };
}

export interface CorpusReport {
	results: TaskResult[];
	clean: Totals;
	sloppy: Totals;
	all: Totals;
}

export function report(results: readonly TaskResult[]): CorpusReport {
	const scores = (pick: (r: TaskResult) => boolean) => summarize(results.filter(pick).map((r) => r.score));
	return { results: [...results], clean: scores((r) => r.variant === "clean"), sloppy: scores((r) => r.variant !== "clean" && r.variant !== "live"), all: scores(() => true) };
}

/**
 * The deterministic corpus: for every task, the careful call and each recorded mistake, replayed by a scripted driver. This does not
 * say how often a MODEL makes these mistakes — it says what the SERVER does when one does: recovers it, names it, or fails it.
 */
export async function runCorpus(host: McpHost, tasks: readonly EvalTask[], scripted: (calls: ToolCall[]) => EvalDriver): Promise<CorpusReport> {
	const session = await openSession(host);
	try {
		const results: TaskResult[] = [];
		for (const task of tasks) {
			for (const v of [{ label: "clean", call: task.clean }, ...task.sloppy]) results.push(await runOne(session, task, scripted([v.call]), v.label));
		}
		return report(results);
	} finally {
		session.close();
	}
}

/** A model chooses each task's first call from the owner's words and the server's real tool list. One call per task. */
export async function runLive(host: McpHost, tasks: readonly EvalTask[], driver: EvalDriver): Promise<CorpusReport> {
	const session = await openSession(host);
	try {
		const results: TaskResult[] = [];
		for (const task of tasks) results.push(await runOne(session, task, driver, "live"));
		return report(results);
	} finally {
		session.close();
	}
}
