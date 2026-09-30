/**
 * Can the machine a session is about to launch on actually run its engine (#879)?
 *
 * An engine the machine does not have used to fail AFTER launch: `spawn codex ENOENT`, or a CLI that
 * came up and stopped on "please log in". #882 made the dead session say why; this asks first, so
 * the answer is a refusal that names the engine instead of a session that dies. It matters most to
 * apply-now (`coding-default-engine-apply.ts`), which ENDS a working session before starting the new
 * one — without a preflight, re-pointing a coder at an engine its machine lacks replaced a working
 * coder with a dead one.
 *
 * Asked of the runner (`POST /coding/engine-check`, CLI {@link ENGINE_CHECK_MIN_CLI}), because only
 * the machine knows its PATH and its stored logins. Only a DEFINITE answer refuses:
 *
 *   ok           — binary found, and the login found or not determinable
 *   no-binary    — the executable is not on the PATH `pags up` spawns with
 *   signed-out   — installed, but the engine's own subscription login is definitely not stored
 *   unverified   — the runner could not say: older than the check (`outdated`), or unreachable
 *
 * What a caller does with `unverified` is its own decision and the two differ on purpose: a session
 * START proceeds exactly as before this existed (nothing is lost if it fails, and #882 explains the
 * death), while apply-now SKIPS, because it would be trading a working session for an unchecked one.
 *
 * Subscription sign-in only. The remedy never mentions an API key: engines run on the owner's own
 * subscription, signed in interactively on the machine or through `coding_engine_reauth`.
 */
import { resolveEngineEnv } from "./coding-engines.js";
import { callRunner, READ_TIMEOUT_MS, type RunnerConn } from "./runner-client.js";
import type { CodingClientType, CodingSessionRecord } from "./coding-types.js";
import type { Env } from "../types.js";

/** The first CLI that answers `/coding/engine-check`. Older runners 404 it. */
export const ENGINE_CHECK_MIN_CLI = "0.4.67";

export type EnginePreflight =
	| { state: "ok" }
	| { state: "no-binary" | "signed-out"; message: string }
	| { state: "unverified"; outdated: boolean; message: string };

interface RawEngineCheck {
	checked?: unknown;
	bin?: unknown;
	binaryFound?: unknown;
	login?: unknown;
	error?: unknown;
}

const ENGINE_NAMES: Record<CodingClientType, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI", grok: "Grok CLI" };

/** How to put the engine on a machine, and how to sign it in with the owner's subscription. */
const ENGINE_SETUP: Record<CodingClientType, { install: string; login: string }> = {
	claude: { install: "`npm i -g @anthropic-ai/claude-code`", login: "run `claude` and sign in with `/login`" },
	codex: { install: "`npm i -g @openai/codex`", login: "run `codex login` and sign in with your ChatGPT account" },
	gemini: { install: "`npm i -g @google/gemini-cli`", login: "run `gemini` and sign in with Google" },
	grok: { install: "the Grok CLI", login: "run `grok` and sign in" },
};

function machineName(conn: RunnerConn): string {
	return conn.runnerNode ? `machine "${conn.runnerNode}"` : "the connected machine";
}

/** The sentences, pure so every branch can be asserted without a runner. */
export function enginePreflightMessage(
	state: "no-binary" | "signed-out" | "outdated" | "unreachable",
	input: { clientType: CodingClientType; bin?: string; machine: string },
): string {
	const name = ENGINE_NAMES[input.clientType] ?? input.clientType;
	const setup = ENGINE_SETUP[input.clientType] ?? { install: `${name}`, login: `sign ${name} in` };
	const signIn = `${setup.login} on that machine, or sign it in from any device with coding_engine_reauth`;
	if (state === "no-binary") {
		return `${name} is not installed on ${input.machine}: \`${input.bin || input.clientType}\` is not on the PATH \`pags up\` runs with. Install it there (${setup.install}), ${signIn}, then restart \`pags up\` — or choose an engine that machine already has.`;
	}
	if (state === "signed-out") {
		return `${name} is installed on ${input.machine} but not signed in there. Sign it in with your subscription — ${signIn} — then try again.`;
	}
	if (state === "outdated") {
		return `${input.machine} runs a \`pags\` CLI older than ${ENGINE_CHECK_MIN_CLI}, which cannot confirm ${name} is installed and signed in there. Update it with runner_update, then try again.`;
	}
	return `${input.machine} did not answer whether ${name} is installed and signed in there.`;
}

/**
 * Will the platform hand this spawn a credential of its own? Then the machine's login is not what
 * the engine reads, and is not checked. Derived from the same `resolveEngineEnv` the launch uses, so
 * the check and the spawn cannot disagree; a failed read counts as "no" (check the machine).
 */
async function credentialInjected(env: Env, instanceId: string, uid: string, session: CodingSessionRecord): Promise<boolean> {
	const overlay = await resolveEngineEnv(env, instanceId, uid, session).catch(() => undefined);
	return Object.values(overlay ?? {}).some((v) => typeof v === "string" && v.trim() !== "");
}

/** Ask the machine. `session` carries the engine to check: `clientType` + `launchCommand`. */
export async function preflightEngine(env: Env, conn: RunnerConn, instanceId: string, uid: string, session: CodingSessionRecord): Promise<EnginePreflight> {
	const clientType = session.clientType;
	const machine = machineName(conn);
	const injected = await credentialInjected(env, instanceId, uid, session);
	let raw: RawEngineCheck;
	try {
		raw = await callRunner<RawEngineCheck>(
			conn,
			"/coding/engine-check",
			{ clientType, command: session.launchCommand || undefined, credentialInjected: injected },
			{ timeoutMs: READ_TIMEOUT_MS },
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		const outdated = /\/coding\/engine-check → 404/.test(msg);
		return { state: "unverified", outdated, message: enginePreflightMessage(outdated ? "outdated" : "unreachable", { clientType, machine }) };
	}
	// `checked: true` is the version marker, as for `/coding/repo-check`: anything else is a runner
	// that did not understand the question, never a verdict about the engine.
	if (raw?.checked !== true) {
		return { state: "unverified", outdated: true, message: enginePreflightMessage("outdated", { clientType, machine }) };
	}
	const bin = typeof raw.bin === "string" ? raw.bin : undefined;
	if (raw.binaryFound === false) return { state: "no-binary", message: enginePreflightMessage("no-binary", { clientType, bin, machine }) };
	if (raw.login === "missing") return { state: "signed-out", message: enginePreflightMessage("signed-out", { clientType, bin, machine }) };
	return { state: "ok" };
}
