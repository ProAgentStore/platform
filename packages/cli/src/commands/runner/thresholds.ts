// `pags runner thresholds` — read and change THIS machine's admission thresholds (#1275).
//
// The runner admission gate refuses a new session on a machine that is overloaded. Its session limit and its
// CPU / memory / disk lines belong to the machine (one policy for every agent that runs here); the platform
// enforces them, so this command is only a way to read them and send a partial change:
//
//   pags runner thresholds                          show what is in force, where each value came from, the verdict
//   pags runner thresholds maxSessions=2            let this machine run two sessions at once
//   pags runner thresholds cpuLoad1PerCpu=2 diskFreeMinGiB=20 memUsedPctMax=null
//   pags runner thresholds --reset                  back to the defaults and the cores/memory formula
//
// A number sets a field, `null` returns it to the default, and a field you leave out is untouched.
import { Command } from "commander";
import { loadMachineIdentity } from "../../machine.js";
import { writeError, writeLine } from "../../output.js";
import { requireSession } from "../login.js";
import { apiPathSegment, pagsApiBase, requestPags } from "./http.js";

const GIB = 1024 ** 3;

/** The fields the API takes, plus the GiB spellings of the two byte floors (a person types 20, not 21474836480). */
const KEYS = ["maxSessions", "cpuLoad1PerCpu", "cpuLoad5PerCpu", "memUsedPctMax", "memAvailableMinBytes", "diskUsedPctMax", "diskFreeMinBytes", "recoveryBand", "recoveryStreak"] as const;
const GIB_ALIASES: Record<string, (typeof KEYS)[number]> = { memAvailableMinGiB: "memAvailableMinBytes", diskFreeMinGiB: "diskFreeMinBytes" };

/** `key=value` words into the partial body the API takes, or what is wrong with them. The server re-validates every range. */
export function parseAssignments(words: readonly string[]): { body: Record<string, number | null> } | { error: string } {
	const body: Record<string, number | null> = {};
	for (const word of words) {
		const eq = word.indexOf("=");
		if (eq <= 0) return { error: `"${word}" is not key=value. Try: maxSessions=2` };
		const rawKey = word.slice(0, eq).trim();
		const text = word.slice(eq + 1).trim();
		const gib = rawKey in GIB_ALIASES;
		const key = gib ? GIB_ALIASES[rawKey] : (KEYS as readonly string[]).includes(rawKey) ? rawKey : null;
		if (!key) return { error: `Unknown threshold "${rawKey}". Known: ${[...KEYS, ...Object.keys(GIB_ALIASES)].join(", ")}.` };
		if (text === "null" || text === "") {
			body[key] = null;
			continue;
		}
		const n = Number(text);
		if (!Number.isFinite(n)) return { error: `${rawKey} must be a number (or null to go back to the default), not "${text}".` };
		body[key] = gib ? Math.round(n * GIB) : n;
	}
	if (!Object.keys(body).length) return { error: "Name at least one threshold, e.g. maxSessions=2." };
	return { body };
}

interface ThresholdsAnswer {
	maxSessions: { value: number | null; source: string; formula: number | null };
	thresholds: Record<string, number>;
	source: Record<string, string>;
	overrides: Record<string, number>;
	verdict: { gate: string; metric?: string; value?: number; threshold?: number };
}

/** The answer as lines a person reads: every threshold in force, and whether this machine sets it. */
export function formatThresholds(t: ThresholdsAnswer): string[] {
	const bytes = (n: number) => `${Math.round((n / GIB) * 100) / 100} GiB`;
	const lines = [`  Gate: ${t.verdict.gate === "accepting" ? "accepting new sessions" : `refusing new sessions (${t.verdict.metric ?? t.verdict.gate})`}`, ""];
	const limit = t.maxSessions;
	lines.push(`  maxSessions            ${String(limit.value ?? "?").padEnd(10)} ${limit.source === "machine" ? "set for this machine" : limit.source === "formula" ? `the cores/memory formula` : "default"}${limit.source === "machine" && limit.formula !== null ? ` (formula: ${limit.formula})` : ""}`);
	for (const key of KEYS.filter((k) => k !== "maxSessions")) {
		const v = t.thresholds[key];
		const shown = key.endsWith("Bytes") && typeof v === "number" ? bytes(v) : String(v);
		lines.push(`  ${key.padEnd(22)} ${shown.padEnd(10)} ${t.source[key] === "machine" ? "set for this machine" : "default"}`);
	}
	return lines;
}

export function thresholdsCommand(): Command {
	return new Command("thresholds")
		.description("Show or change this machine's admission thresholds (session limit and CPU / memory / disk lines)")
		.argument("[assignments...]", "key=value pairs to change, e.g. maxSessions=2 diskFreeMinGiB=20 (null returns one to its default)")
		.option("--reset", "Remove every override on this machine")
		.option("--machine <id>", "Act on another machine by its id (default: this one)")
		.option("--json", "Print the platform's answer as JSON")
		.action(async (words: string[], opts: { reset?: boolean; machine?: string; json?: boolean }) => {
			const session = requireSession();
			const machineId = opts.machine?.trim() || loadMachineIdentity().id;
			if (!machineId) {
				writeError("This machine has no id yet — run `pags up` once, or pass --machine <id> (see list_runner_nodes).");
				process.exit(1);
			}
			if (opts.reset && words.length) {
				writeError("Give --reset or key=value pairs, not both.");
				process.exit(1);
			}
			let method = "GET";
			let body: Record<string, number | null> | undefined;
			if (opts.reset) method = "DELETE";
			else if (words.length) {
				const parsed = parseAssignments(words);
				if ("error" in parsed) {
					writeError(`  ✗ ${parsed.error}`);
					process.exit(1);
				}
				method = "PUT";
				body = parsed.body;
			}
			try {
				const answer = await requestPags<ThresholdsAnswer>(method, `/v1/terminals/machines/${apiPathSegment(machineId)}/thresholds`, { pagsToken: session.token, apiBase: pagsApiBase() }, body);
				if (opts.json) {
					writeLine(JSON.stringify(answer, null, 2));
					return;
				}
				writeLine("");
				if (method !== "GET") writeLine(method === "DELETE" ? "  ✓ Every override removed." : "  ✓ Saved. It applies from this machine's next heartbeat; a session already running is untouched.");
				for (const line of formatThresholds(answer)) writeLine(line);
				writeLine("");
			} catch (e) {
				writeError(`  ✗ ${e instanceof Error ? e.message : String(e)}`);
				process.exit(1);
			}
		});
}
