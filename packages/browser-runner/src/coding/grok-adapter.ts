/**
 * Grok's structured output, read into the same events Claude's and Codex's are (#1187).
 *
 * The `grok` preset ran `grok --permission-mode bypassPermissions -p`, which prints plain text — so a Grok run
 * left nothing the platform could check: every claim came back UNVERIFIED ("this engine's tool calls are not
 * observable"), while a Claude or Codex run's evidence check could say verified or CONTRADICTED. xAI's CLI has
 * `--output-format streaming-json`: NDJSON, "one ACP session update per line". This adapter adds that flag (and
 * `--no-auto-update`, xAI's advice for automated use, so an update check cannot interleave with the stream) and
 * turns the stream into `tool_use` / `tool_result` / `turn_end` — which `headless.ts` renders into the pane the
 * evidence check reads, exactly as it does for the other two engines.
 *
 * The shapes, captured from xAI's Grok CLI 1.0.62 (2026-10-19), one `run_terminal_command` that succeeded and one
 * that failed:
 *
 *   {"type":"tool_call","toolCallId":"call-…-0","title":"run_terminal_command","kind":"execute","status":"pending",
 *    "toolName":"run_terminal_command","rawInput":{"command":"echo PAGS_PROBE_42","description":"…"},…}
 *   {"type":"tool_call_update","toolCallId":"call-…-0","status":"completed",
 *    "content":[{"type":"content","content":{"type":"text","text":"PAGS_PROBE_42\n"}}],
 *    "rawOutput":{"type":"Bash","exit_code":0,"command":"echo PAGS_PROBE_42","output_for_prompt":"exit: 0\nPAGS_PROBE_42\n",…}}
 *   {"type":"text","data":"I'll"}  {"type":"text","data":" run"} …   — token-sized deltas
 *   {"type":"end","stopReason":"end_turn","sessionId":"…","usage":{…},"total_cost_usd":0.03,…}
 *
 * plus `thought`, `usage` and `available_commands`, which say nothing a reader of the pane needs. Only the
 * terminal tool was exercised; a non-terminal tool (an edit, a read) is passed through under its own name with
 * its raw input, and its result still settles the call.
 */
import type { EngineAdapter, NormalizedEngineEvent } from "./engine-adapter.js";

function record(v: unknown): Record<string, unknown> | null {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function hasFlag(args: readonly string[], flag: string): boolean {
	return args.some((a) => a === flag || a.startsWith(`${flag}=`));
}

/** The value a preset gave `--output-format`, or null. */
export function grokOutputFormat(args: readonly string[]): string | null {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--output-format") return args[i + 1] ?? null;
		if (args[i].startsWith("--output-format=")) return args[i].slice("--output-format=".length);
	}
	return null;
}

/** The preset's argv with the structured-output flags in front — any order parses, and the trailing `-p` stays last. */
export function grokStructuredArgs(userArgs: readonly string[]): string[] {
	const add: string[] = [];
	if (!grokOutputFormat(userArgs)) add.push("--output-format", "streaming-json");
	if (!hasFlag(userArgs, "--no-auto-update")) add.push("--no-auto-update");
	return [...add, ...userArgs];
}

/** The text a terminal call produced: its content blocks, else `output_for_prompt` without its `exit: N` header. */
function toolOutput(ev: Record<string, unknown>, raw: Record<string, unknown> | null): string {
	const texts = (Array.isArray(ev.content) ? ev.content : []).flatMap((c) => {
		const inner = record(record(c)?.content);
		return typeof inner?.text === "string" ? [inner.text] : [];
	});
	if (texts.some((t) => t.trim())) return texts.join("");
	const prompt = typeof raw?.output_for_prompt === "string" ? raw.output_for_prompt : "";
	return prompt.replace(/^exit: -?\d+\n/, "");
}

/** A Grok call as the tool the rest of the runner knows: its terminal tool IS a Bash call. */
function asTool(ev: Record<string, unknown>): { name: string; input: unknown } {
	const rawInput = record(ev.rawInput) ?? {};
	if (ev.kind === "execute" && typeof rawInput.command === "string") return { name: "Bash", input: { command: rawInput.command } };
	return { name: typeof ev.toolName === "string" && ev.toolName ? ev.toolName : String(ev.title ?? "tool"), input: rawInput };
}

/** One session's adapter: it holds the reply being streamed in deltas until something else happens. */
export function createGrokEngineAdapter(): EngineAdapter {
	let text = "";
	const flush = (): NormalizedEngineEvent[] => {
		const t = text.trim();
		text = "";
		return t ? [{ kind: "assistant_text", text: t }] : [];
	};

	function parseLine(line: string): NormalizedEngineEvent[] {
		let ev: Record<string, unknown> | null;
		try {
			ev = record(JSON.parse(line));
		} catch {
			return [];
		}
		if (!ev) return [];
		switch (ev.type) {
			case "text":
				if (typeof ev.data === "string") text += ev.data;
				return [{ kind: "meta" }];
			case "thought":
			case "usage":
			case "available_commands":
				return [{ kind: "meta" }];
			case "tool_call": {
				const id = typeof ev.toolCallId === "string" ? ev.toolCallId : "";
				const { name, input } = asTool(ev);
				return [...flush(), { kind: "tool_use", block: { type: "tool_use", id, name, input }, id, name, input }];
			}
			case "tool_call_update": {
				// Pending and in-progress updates are the same call filling in; only its END settles it.
				if (ev.status !== "completed" && ev.status !== "failed") return [{ kind: "meta" }];
				const id = typeof ev.toolCallId === "string" ? ev.toolCallId : "";
				const raw = record(ev.rawOutput);
				const exitCode = typeof raw?.exit_code === "number" ? raw.exit_code : null;
				const content = toolOutput(ev, raw);
				const block = { type: "tool_result", tool_use_id: id, is_error: ev.status === "failed" || (exitCode !== null && exitCode !== 0), content };
				return [{ kind: "tool_result", block, toolUseId: id, content }];
			}
			case "end": {
				const stop = typeof ev.stopReason === "string" ? ev.stopReason : "";
				const isError = stop !== "end_turn";
				return [...flush(), { kind: "turn_end", raw: ev, isError, result: isError ? `stopped: ${stop || "unknown"}` : "" }];
			}
			case "error": {
				const message = typeof ev.message === "string" ? ev.message : typeof record(ev.error)?.message === "string" ? (record(ev.error)?.message as string) : "";
				return message.trim() ? [{ kind: "engine_error", text: message.trim() }] : [{ kind: "meta" }];
			}
			default:
				return [];
		}
	}

	return {
		mode: "stream-json",
		persistent: false,
		prepareArgs: grokStructuredArgs,
		buildLaunchArgs: (userArgs) => [...userArgs],
		buildTurnArgs: (userArgs, turnText) => [...userArgs, turnText],
		parseLine,
		// An older Grok CLI that does not know a flag refuses before it runs the prompt, so one retry raw is safe.
		rejectsStructuredOutput: (line) => /(?:--output-format|--no-auto-update|streaming-json)/.test(line) && /(?:unexpected argument|unknown (?:argument|option)|unrecognized|invalid value|isn't a valid value)/i.test(line),
	};
}
