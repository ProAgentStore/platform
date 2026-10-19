import { type CallAuditRecord, callEvent, currentCallAudit, errorName, newCallRecord, noteArguments, withCallAudit } from "./call-audit.js";
import { actionableInputError, closestToolNames, normalizeArguments, type RawShape } from "./argument-normalize.js";
import { correlationFromExtra, currentCallCorrelation, withCallCorrelation } from "./call-context.js";
import type { TextResult } from "./http.js";
import { auditCallOutcome, type SafetyContext } from "./safety.js";
import { recordLatency } from "./latency.js";
import { titleFor } from "./tool-metadata.js";

/**
 * The ONE place every tool registration passes through.
 *
 * Two jobs, both of which have to be done at REGISTRATION time rather than per handler:
 *
 * 1. **The operator-suspension gate (#273).** The bug it closes was a hole in a per-handler
 *    check: the GitHub-backed tools (scaffold, repo files, deploy) never call the API, so
 *    they never met `requireUser`, and `agent_deploy_status` took no token at all. Adding
 *    one more line to seven handlers would fix those seven and leave the eighth tool — the
 *    one nobody has written yet — exactly as exposed. Wrapping the registrar means a tool
 *    cannot opt out of the gate, including everything `registerInstanceTools` /
 *    `registerStorageTools` register and anything added later in any file.
 *
 * 2. **Tool metadata** (#561). Every call site uses the SDK's tuple overload,
 *    `tool(name, description, shape, cb)`, which the SDK froze at protocol 2025-03-26:
 *    "Support for this style is frozen … Future additions to tool definition should *NOT*
 *    be added" (`@modelcontextprotocol/sdk` `dist/esm/server/mcp.js:665-667`). On that path
 *    `outputSchema` is declared and never assigned, and `title` is unreachable. So a server
 *    that registers through it can never publish anything the spec added after that date,
 *    however many call sites it edits.
 *
 *    Translating the tuple into a `registerTool(name, config, cb)` call HERE moves all 135
 *    registrations onto the current path at once, and gives one seam where per-tool
 *    metadata is merged in. The call sites stay exactly as they are.
 *
 * 3. **One audit event per call (#1089).** Every call — refused, previewed, failed, thrown, rejected
 *    by schema validation, or completed — closes with exactly one metadata-only event, written here
 *    rather than by each handler (see `call-audit.ts`). With the real SDK server underneath, the
 *    record is opened at its `tools/call` handler, the only boundary a schema-validation failure or
 *    an output-schema rejection passes through; the handler wrapper below fills it in.
 *
 * The handler is always the last function argument across every `tool(...)` overload
 * (name+cb, name+desc+cb, name+desc+schema+cb), so it is found by scanning from the end
 * rather than by assuming an arity.
 */

type AnyFn = (...args: unknown[]) => unknown;

/** What this module needs of an `McpServer` — the real one, or a test double. */
export interface RegistrationTarget {
	tool: (...args: unknown[]) => unknown;
	registerTool: (name: string, config: Record<string, unknown>, cb: AnyFn) => unknown;
	/** The SDK's low-level server, when there is one: where `tools/call` is dispatched. */
	server?: unknown;
}

type RequestHandler = (request: unknown, extra: unknown) => Promise<unknown>;

export interface RegistrationOptions {
	/** Returns a refusal to answer with INSTEAD of running the tool, or null to proceed.
	 *  `provided` is the caller's own `token` argument when it passed one. */
	gate: (name: string, provided?: string) => Promise<TextResult | null>;
	/** Per-tool metadata merged into the registration config (annotations, output schema). */
	metadata?: (name: string) => Record<string, unknown> | undefined;
	/**
	 * Called after every call the gate let through, with the tool's name and the caller's raw
	 * arguments (#787). It records which instance the call was about — see `recent-instances.ts`
	 * for why that is recorded here and not in the ~80 handlers that take an `instance_id`: the
	 * same "the tool nobody has written yet" argument that put the gate here. Its result is
	 * ignored and it must not throw; it never changes what the caller receives.
	 */
	touch?: (name: string, input: Record<string, unknown> | undefined, provided?: string) => Promise<void>;
	/**
	 * The audit context for a call made as `provided` (or as the connection). When given, every call
	 * is recorded as one outcome event (#1089); the context's `callAudit` must read
	 * `currentCallAudit` so the handler's own `audit()` calls are absorbed into it.
	 */
	safety?: (provided?: string) => SafetyContext;
	/** True for a tool OUR risk table classes as read-only — never read off published annotations. */
	readOnly?: (name: string) => boolean;
}

/** Close a call's record with its one event. Never throws, never changes what the caller receives. */
async function finishCall(rec: CallAuditRecord, safety: (provided?: string) => SafetyContext): Promise<void> {
	if (rec.finished) return;
	rec.finished = true;
	try {
		const event = callEvent(rec);
		if (event) await auditCallOutcome(safety(rec.provided), event);
	} catch (e) {
		console.warn(JSON.stringify({ event: "mcp.call_audit_failed", tool: rec.tool, error: errorName(e) }));
	}
}

/**
 * Wrap the SDK's `tools/call` dispatcher so the call's record exists BEFORE input validation. The
 * handler map is the SDK's own (`Protocol._requestHandlers`); if a future SDK moves it, this returns
 * false, the handler wrapper still records every call that reaches a handler, and the conformance
 * test that drives a schema-invalid call through a real client fails.
 */
function wrapToolsCall(target: RegistrationTarget, registered: Map<string, boolean>, safety: (provided?: string) => SafetyContext, shapes: Map<string, RawShape>): boolean {
	const handlers = (target.server as { _requestHandlers?: unknown } | undefined)?._requestHandlers;
	if (!(handlers instanceof Map)) return false;
	const original = handlers.get("tools/call") as RequestHandler | undefined;
	if (!original) return false;
	handlers.set("tools/call", (request: unknown, extra: unknown) => {
		const params = (request as { params?: { name?: unknown; arguments?: unknown } } | undefined)?.params;
		const name = typeof params?.name === "string" && registered.has(params.name) ? params.name : "(unregistered)";
		const rec = newCallRecord(name, registered.get(name) === true);
		// #1241: a camelCase key or a list in the other form is fixed HERE, before the SDK validates, for every tool — and said.
		const { args, warnings } = normalizeArguments(shapes.get(name), params?.arguments);
		const call = warnings.length ? { ...(request as object), params: { ...params, arguments: args } } : request;
		noteArguments(rec, args);
		const token = (params?.arguments as { token?: unknown } | undefined)?.token;
		if (typeof token === "string" && token) rec.provided = token;
		return withCallCorrelation(correlationFromExtra(extra), () =>
			withCallAudit(rec, async () => {
				try {
					rec.final = explainResult(await original(call, extra), { name, requested: params?.name, shape: shapes.get(name), args, warnings, registered });
					return rec.final;
				} catch (e) {
					// Thrown out of the SDK (a URL elicitation, or a fault in the SDK itself): no result reached the caller.
					if (!rec.ran) rec.final = { isError: true, content: [{ type: "text", text: "protocol error" }] };
					else rec.thrown ??= errorName(e);
					throw e;
				} finally {
					await finishCall(rec, safety);
				}
			}),
		);
	});
	return true;
}

/**
 * The SDK's answer, made usable (#1241): a schema failure names each bad argument, lists what the tool
 * takes and gives a corrected example; an unknown tool name suggests the nearest real ones; and any
 * argument rewritten or ignored on the way in is said, as a note after the result. A tool's own
 * result is otherwise returned as it was — nothing is added to a call that needed no fixing.
 */
function explainResult(result: unknown, c: { name: string; requested: unknown; shape?: RawShape; args: unknown; warnings: string[]; registered: Map<string, boolean> }): unknown {
	const r = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> } | undefined;
	const text = r?.content?.[0]?.type === "text" ? (r.content[0].text ?? "") : "";
	const notes = c.warnings.length ? `\n\nNote:\n${c.warnings.map((w) => `- ${w}`).join("\n")}` : "";
	// The SDK prefixes its own refusals with "MCP error -32602: ".
	if (r?.isError && /^(MCP error -?\d+: )?Input validation error/.test(text)) {
		return { ...r, content: [{ type: "text", text: actionableInputError(c.name, c.shape, c.args, text) + notes }, ...(r.content ?? []).slice(1)] };
	}
	if (r?.isError && /^(MCP error -?\d+: )?Tool \S+ not found/.test(text) && typeof c.requested === "string") {
		const near = closestToolNames(c.requested, c.registered.keys());
		const hint = near.length ? ` Did you mean ${near.map((n) => `\`${n}\``).join(", ")}?` : "";
		return { ...r, content: [{ type: "text", text: `${text.replace(/^MCP error -?\d+: /, "")}.${hint} This connection's tools are in tools/list; an instance's own connector tools are reached with call_instance_tool (list them with list_instance_tools).` }] };
	}
	if (notes && r && Array.isArray(r.content)) return { ...r, content: [...r.content, { type: "text", text: notes.trimStart() }] };
	return result;
}

export function installRegistrationPipeline(
	server: RegistrationTarget,
	opts: RegistrationOptions,
): void {
	const registerTool = server.registerTool.bind(server);
	// Every registered name → whether it is read-only, so the boundary can tell a known tool from an
	// arbitrary caller-supplied name before any handler runs.
	const registered = new Map<string, boolean>();
	// Every registered name → its zod raw shape, for the argument fixes and errors at the `tools/call` seam (#1241).
	const shapes = new Map<string, RawShape>();
	let boundaryWrapped = false;
	server.tool = (...args: unknown[]) => {
		let i = args.length - 1;
		while (i >= 0 && typeof args[i] !== "function") i--;
		const name = typeof args[0] === "string" ? args[0] : null;
		if (i < 0 || !name) {
			// Not a shape this pipeline understands. Registering it unchanged would skip the
			// suspension gate, so refuse loudly instead of quietly publishing an ungated tool.
			throw new Error("mcp: tool registration without a name or a handler");
		}
		const handler = args[i] as AnyFn;
		const metadata = opts.metadata?.(name) ?? {};
		const readOnly = opts.readOnly?.(name) === true;
		registered.set(name, readOnly);
		const run = async (...handlerArgs: unknown[]) => {
			// A tool may carry its own `token` argument (acting as someone other than the
			// connection), so gate the identity the handler will actually use, not just
			// the connection's.
			const first = handlerArgs[0] as { token?: unknown } | undefined;
			const provided = typeof first?.token === "string" ? first.token : undefined;
			const safety = opts.safety;
			if (!safety) return execute(first, provided, handlerArgs);
			// The record the `tools/call` boundary opened for THIS call, or a fresh one when this handler
			// was reached another way (a test double, or a handler calling another tool in-process).
			const outer = currentCallAudit();
			const own = outer && !outer.claimed && outer.tool === name ? outer : undefined;
			const rec = own ?? newCallRecord(name, readOnly);
			rec.claimed = true;
			rec.provided = provided;
			if (!own) noteArguments(rec, first);
			return withCallAudit(rec, async () => {
				try {
					rec.result = await execute(first, provided, handlerArgs, rec);
					return rec.result;
				} catch (e) {
					rec.thrown = errorName(e);
					throw e;
				} finally {
					// The boundary closes its own record once the SDK has answered; anything else closes here.
					if (!own) {
						rec.final = rec.result;
						await finishCall(rec, safety);
					}
				}
			});
		};
		const execute = async (first: { token?: unknown } | undefined, provided: string | undefined, handlerArgs: unknown[], rec?: CallAuditRecord) => {
			const blocked = await opts.gate(name, provided);
			if (rec) {
				if (blocked) rec.gate = { check: "denied", reason: rec.gate?.reason ?? "gate" };
				else rec.ran = true;
			}
			// The whole handler is one `tool` latency sample (#198) — the stage the incident's
			// numbers were quoted in. A blocked call is not timed: nothing ran.
			let result: unknown;
			if (blocked) {
				result = blocked;
			} else {
				const started = Date.now();
				try {
					result = await handler(...handlerArgs);
				} catch (err) {
					recordLatency({ stage: "tool", name, ms: Date.now() - started, ok: false });
					throw err;
				}
				recordLatency({ stage: "tool", name, ms: Date.now() - started, ok: true });
			}
			// After the handler, so a slow KV never delays the answer's computation — and only for a
			// call that ran: a suspended account's attempts are not "work it was doing".
			if (!blocked && opts.touch) await opts.touch(name, first as Record<string, unknown> | undefined, provided);
			const shaped = metadata.outputSchema ? withStructuredContent(result) : result;
			// A call that can change something says which call it was (#1111), so a caller can tell its
			// own answer from anyone else's. Read-only results stay as they are.
			return readOnly ? shaped : withCallReceipt(shaped, name, first as Record<string, unknown> | undefined);
		};

		// Every handler runs inside its own request's correlation (#1038), so whatever it audits
		// carries the JSON-RPC id and session the caller can look it up by after a lost reply.
		const gated = (...handlerArgs: unknown[]) => withCallCorrelation(correlationFromExtra(handlerArgs[1]), () => run(...handlerArgs));

		const description = typeof args[1] === "string" ? (args[1] as string) : undefined;
		// The zod raw shape, if this call site passed one: the last object between the
		// description and the handler.
		let inputSchema: Record<string, unknown> | undefined;
		for (let j = 1; j < i; j++) {
			const arg = args[j];
			if (typeof arg === "object" && arg !== null) inputSchema = arg as Record<string, unknown>;
		}
		if (inputSchema) shapes.set(name, inputSchema as RawShape);

		const registeredTool = registerTool(
			name,
			{
				title: titleFor(name),
				...(description === undefined ? {} : { description }),
				...(inputSchema === undefined ? {} : { inputSchema }),
				...metadata,
			},
			gated,
		);
		// The SDK installs its `tools/call` dispatcher on the first registration; wrap it once, then.
		if (!boundaryWrapped && opts.safety) boundaryWrapped = wrapToolsCall(server, registered, opts.safety, shapes);
		return registeredTool;
	};
}

/**
 * The safety net under an output schema.
 *
 * Declaring one is a promise the SDK enforces: a tool with an `outputSchema` that returns
 * no `structuredContent` gets its call REJECTED (`validateToolOutput`, mcp.js:197). The
 * handler supplies it on the paths it knows about — but two refusals do not come from the
 * handler at all. `authRequired()` is returned before it runs, and the suspension gate
 * above replaces the result entirely. Without this, adding a schema to a tool would turn
 * "you are not signed in" into a protocol error, on the exact tools a caller reaches first.
 *
 * Every such text is a refusal (that is the only way a result reaches here without
 * structure), so reporting it as `error` is what it is. Each schema declares that field.
 */
function withStructuredContent(result: unknown): unknown {
	if (!result || typeof result !== "object") return result;
	const shaped = result as { content?: Array<{ text?: string }>; structuredContent?: unknown };
	if (shaped.structuredContent !== undefined) return result;
	return { ...shaped, structuredContent: { error: shaped.content?.[0]?.text ?? "No result." } };
}

/** The `_meta` key a mutation's receipt is published under (#1111). */
export const RECEIPT_META_KEY = "proagentstore.online/receipt";

/** The input fields that name what a call acted on, most specific first. Values only — never content. */
const TARGET_FIELDS = ["instance_id", "agent_id", "session_id", "run_id", "entry_id", "task_id", "job_key", "application_id", "trigger_id", "connection_id", "repo_id", "repo", "id"] as const;

/** What a call acted on, as `field=value` — the first naming field its input carries, or "n/a". */
export function receiptTarget(input: Record<string, unknown> | undefined): string {
	for (const f of TARGET_FIELDS) {
		const v = input?.[f];
		if ((typeof v === "string" && v) || typeof v === "number") return `${f}=${String(v)}`;
	}
	return "n/a";
}

/**
 * Attach the call's own receipt to a mutating tool's result (#1111): the tool, the JSON-RPC request id
 * and MCP session it answers, and what it acted on — as `_meta` for clients and as a final text block
 * for a model reading the content. An extra content item, never a change to the first: callers parse
 * `content[0].text` as JSON. Ids the call never carried read "unknown" rather than vanish.
 */
export function withCallReceipt(result: unknown, tool: string, input: Record<string, unknown> | undefined): unknown {
	const r = result as { content?: unknown; _meta?: Record<string, unknown> } | null;
	if (!r || typeof r !== "object" || !Array.isArray(r.content)) return result;
	const c = currentCallCorrelation();
	const receipt = { tool, requestId: c?.requestId ?? "unknown", mcpSessionId: c?.mcpSessionId ?? "unknown", target: receiptTarget(input) };
	const text = `---MCP-RECEIPT---\ntool: ${receipt.tool}\nrequestId: ${receipt.requestId}\nmcpSessionId: ${receipt.mcpSessionId}\ntarget: ${receipt.target}\n---END-RECEIPT---`;
	return { ...r, content: [...r.content, { type: "text", text }], _meta: { ...(r._meta ?? {}), [RECEIPT_META_KEY]: receipt } };
}
