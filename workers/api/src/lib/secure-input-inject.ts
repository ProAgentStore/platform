/**
 * Deliver a ready secure input into a terminal pane — and say whether it got there (#966, #1140).
 *
 * Before this, `secure_input_inject` called a route that returned the PLAINTEXT to the MCP worker,
 * which dropped it and answered `success: true`. Nothing was ever typed; the one-shot value was spent;
 * the owner fell back to pasting a gcloud code into chat — the leak the feature exists to prevent.
 *
 * Now the platform types it itself, over the same runner path `tmux_send_message` uses (`/tmux/send`,
 * text then Enter), and VERIFIES it. Two ways, chosen by the pane before anything is consumed:
 *
 *   • ECHO (#966) — the value must appear on the pane once more than it did before the typing. A
 *     value that did not land is cleared from the line (C-u), never submitted, and RESTORED — as
 *     `tmux_secure_get` restores one whose file write failed — so the owner does not re-enter it.
 *   • OUTCOME (#1140) — a password prompt never echoes, so the pane must END with a recognised secret
 *     prompt, the value is typed and submitted, and the program must move on without re-prompting
 *     or printing a rejection (`secure-input-hidden.ts`). A rejected value was submitted, so it is
 *     spent: the prompt gets C-c and the answer says so.
 *
 * A target with a backend prefix (`tmux:main`, `kitty:3`) goes through the generic terminal
 * connector's runner paths, under that connector's declared backend ceiling and binding (#404, #402);
 * a bare name is a tmux session, under the tmux binding. tmux itself turns `:` in a session name
 * into `_`, so the two cannot be confused.
 *
 * It is held to the same write-consent as `*_send_keys` (#1145): the connector whose runner path types
 * it (`terminal` for a prefixed target, `tmux` for a bare one) must have the owner's write consent on
 * this instance. NOT exempt because the owner typed the value: entering a secret consents to handing
 * it over, not to letting the agent type into a pane — the agent picks the `target`, as it does for
 * `*_send_keys`. And the file sibling `tmux_secure_get` is already behind this gate via
 * `runRegistryTool`; exempting the terminal path would make one secure-input delivery gated and the
 * other not. A per-call (`ask`) consent is refused too: inject cannot be queued as a board ticket, and
 * typing without that per-call approval would be exactly what `ask` forbids.
 *
 * The value never leaves this module: the pane that comes back from the runner shows it, so the pane
 * is read here for verification and returned NOWHERE — not in the result, a log, or a trace.
 */
import type { Env } from "../types.js";
import { lookupConnectorConstraints } from "./agent-capabilities.js";
import { consentModeFor } from "./connector-consent.js";
import { TERMINAL_TOOLS } from "./connectors/terminal.js";
import { TMUX_TOOLS } from "./connectors/tmux.js";
import { callRunner, getBoundRunnerConn, READ_TIMEOUT_MS, type RunnerConn } from "./runner-client.js";
import { trailingSecretPrompt, watchHiddenOutcome, hiddenOutcomeTiming } from "./secure-input-hidden.js";
import { consumeSecureInput, getSecureInputStatus, restoreConsumedSecureInput } from "./secure-input.js";
import { enforceConstraints } from "./surface-options.js";

export interface SecureInjectResult {
	/** Verified: the value is on the prompt line (echo), or the prompt accepted it (outcome). */
	delivered: boolean;
	/** Why not, in words an operator can act on — never containing the value. Absent when delivered. */
	reason?: string;
	/** Enter was pressed after the value was typed. */
	submitted: boolean;
	/** Whether the one-shot value was spent. True when delivered, or when a hidden prompt rejected it. */
	consumedValue: boolean;
	/** The tmux session or terminal target it was typed into (or would have been). */
	target: string | null;
	/** The request's status after this call. */
	status: string;
	/** The value's character count, as `secure_input_status` reports it. */
	length?: number;
	/** How delivery was judged: the value seen on the pane, or the password prompt's outcome. */
	verifiedBy?: "echo" | "outcome";
	/**
	 * An echoed value, after delivery (#1166): `cleared` — the tmux pane's scrollback was cleared; `masked` — the
	 * runner masks it in every later capture. False on a runner older than the scrub, or a backend it cannot clear.
	 */
	scrubbed?: { cleared: boolean; masked: boolean };
}

/** How many times `needle` occurs in `hay`, line wraps ignored — a long code wraps across pane rows. */
export function occurrences(hay: string, needle: string): number {
	const flat = hay.replace(/\n/g, "");
	if (!needle) return 0;
	let n = 0;
	for (let i = flat.indexOf(needle); i !== -1; i = flat.indexOf(needle, i + needle.length)) n++;
	return n;
}

type SendResult = { pane?: string; paneBefore?: string; changed?: boolean };

/** One pane, whichever connector reaches it. */
interface Pane {
	send(body: { text?: string; keys?: string[] }): Promise<SendResult>;
	capture(): Promise<string>;
}

const TERMINAL_PREFIX = /^(tmux|kitty|iterm2):/i;

function paneFor(conn: RunnerConn, target: string): Pane {
	if (TERMINAL_PREFIX.test(target)) {
		return {
			send: (b) => callRunner<SendResult>(conn, "/terminal/send", { target, ...b, unmasked: true }),
			capture: async () => (await callRunner<{ pane?: string }>(conn, "/terminal/capture", { target, lines: 200, unmasked: true }, { timeoutMs: READ_TIMEOUT_MS })).pane ?? "",
		};
	}
	return {
		send: (b) => callRunner<SendResult>(conn, "/tmux/send", { session: target, ...b, unmasked: true }),
		capture: async () => (await callRunner<{ pane?: string }>(conn, "/tmux/capture", { session: target, lines: 200, unmasked: true }, { timeoutMs: READ_TIMEOUT_MS })).pane ?? "",
	};
}

/**
 * The agent's declared ceiling and binding for the connector this target belongs to — refusal or null.
 * A `tmux:` target answers to BOTH: the terminal ceiling for the prefix, and the tmux session binding
 * for the pane it names, so the prefix is not a way around a tmux Operator's bound session.
 */
async function constraintRefusal(env: Env, instanceId: string, userId: string, target: string): Promise<string | null> {
	const gates: Array<[connector: string, tool: string, input: Record<string, unknown>]> = [];
	if (TERMINAL_PREFIX.test(target)) gates.push(["terminal", "terminal_send_keys", { target }]);
	if (!TERMINAL_PREFIX.test(target) || /^tmux:/i.test(target)) gates.push(["tmux", "tmux_send_keys", { session: target.replace(/^tmux:/i, "") }]);
	try {
		for (const [connector, name, gateInput] of gates) {
			const tool = [...TERMINAL_TOOLS, ...TMUX_TOOLS].find((t) => t.name === name);
			if (!tool) continue;
			const found = await lookupConnectorConstraints(env, instanceId, userId, connector);
			const gated = enforceConstraints(tool, found.instance === "found" ? found.spec : undefined, gateInput);
			if (!gated.ok) return gated.refusal;
		}
		return null;
	} catch {
		return "This agent's terminal constraints could not be read, so nothing was typed. Try again.";
	}
}

/**
 * The write-consent `*_send_keys` is held to in `runRegistryTool`, for the connector whose runner
 * path types into this target — refusal or null (#1145). Fail-closed: no consent, or `ask`, refuses.
 */
async function consentRefusal(env: Env, instanceId: string, target: string): Promise<string | null> {
	const connector = TERMINAL_PREFIX.test(target) ? "terminal" : "tmux";
	const route = `PUT /v1/instances/${instanceId}/connectors/${connector}/consent`;
	const mode = await consentModeFor(env, instanceId, connector, "write");
	if (!mode) return `Typing into a terminal via the ${connector} connector isn't permitted for this agent. Enable write access for ${connector} in the instance's Connections settings (${route}), then inject again.`;
	if (mode === "ask") return `The ${connector} connector's write access is set to ask on every call, and an inject cannot be queued for approval. Set it to always allow in the instance's Connections settings (${route}), then inject again.`;
	return null;
}

/**
 * After an echoed delivery (#1166): the runner clears the tmux pane's scrollback and masks the value in every
 * later capture, so the next reader of that pane — an agent, a capture tool, a crash tail — does not get it.
 * Best-effort: the value already landed, and an older runner (404) simply leaves it as before.
 */
async function scrubDelivered(conn: RunnerConn, target: string, value: string): Promise<{ cleared: boolean; masked: boolean }> {
	try {
		const r = await callRunner<{ remembered?: boolean; cleared?: boolean }>(conn, "/secure/scrub", { target, value }, { timeoutMs: READ_TIMEOUT_MS });
		return { cleared: r?.cleared === true, masked: r?.remembered === true };
	} catch {
		return { cleared: false, masked: false };
	}
}

/** A runner error names the session or the endpoint — and is scrubbed of the value regardless. */
function errorText(e: unknown, value: string): string {
	const msg = e instanceof Error ? e.message.replace(/^Runner \/(?:tmux|terminal)\/\w+ → \d+: /, "") : String(e);
	return value ? msg.split(value).join("[redacted]") : msg;
}

export async function injectSecureInputToTmux(
	env: Env,
	input: { instanceId: string; userId: string; requestId: string; target?: string | null; submit: boolean; hidden?: boolean },
): Promise<SecureInjectResult | null> {
	const status = await getSecureInputStatus(env, input.requestId, input.instanceId, input.userId);
	if (!status) return null;
	const target = (input.target ?? "").trim() || status.target || null;
	const base = { submitted: false, target, length: status.length };
	const refuse = (reason: string): SecureInjectResult => ({ ...base, delivered: false, reason, consumedValue: false, status: status.status });

	if (status.status !== "ready") return refuse(`The request is ${status.status}, not ready — ${status.status === "pending" ? "the owner has not entered the value yet" : "there is no value to inject"}.`);
	if (status.destinationScope !== "tmux") return refuse(`This request is for ${status.destinationScope}, and inject delivers to a terminal only. For a file, use tmux_secure_get with this request id as the handle.`);
	if (!target) return refuse("Name the tmux session or terminal target to type into: `target` (see tmux_list_sessions or terminal_list_targets). Nothing was consumed.");
	if (status.empty) return refuse("The submitted value is empty — ask the owner to enter it again.");
	// iTerm2's `write text` always presses Return and takes no key events, so a value could be neither
	// held unsubmitted for checking nor cleared off a wrong prompt.
	if (/^iterm2:/i.test(target)) return refuse("iTerm2 targets cannot be typed into without submitting, or sent C-u/C-c — use a tmux or kitty target. Nothing was consumed.");

	const denied = await consentRefusal(env, input.instanceId, target);
	if (denied) return refuse(`${denied} Nothing was consumed.`);
	const refusal = await constraintRefusal(env, input.instanceId, input.userId, target);
	if (refusal) return refuse(`${refusal} Nothing was consumed.`);

	const conn = await getBoundRunnerConn(env, input.instanceId, input.userId).catch(() => null);
	if (!conn) return refuse("No runner is connected for this agent — run `pags up` on the machine with the terminal. Nothing was consumed.");
	const pane = paneFor(conn, target);

	// Read the pane BEFORE anything is spent: whether it ends at a password prompt decides how the
	// delivery can be verified, and a hidden prompt that is not there is refused here (#1140).
	let before: string | null = null;
	if (input.hidden !== false) {
		try {
			before = await pane.capture();
		} catch (e) {
			return refuse(`Reading "${target}" failed: ${errorText(e, "")}. Nothing was consumed.`);
		}
	}
	const prompt = before == null ? null : trailingSecretPrompt(before);
	const hidden = input.hidden === true || (input.hidden === undefined && prompt != null);
	if (hidden && !prompt) {
		return refuse(`"${target}" does not end with a password or passphrase prompt, so a hidden value has nowhere verifiable to go. Start the command that asks for it, then inject again. Nothing was consumed.`);
	}
	if (hidden && !input.submit) {
		return refuse(`"${target}" is at a password prompt, which hides what is typed — delivery can only be confirmed by what happens after Enter, so submit:false cannot be honoured. Nothing was consumed.`);
	}

	// Spent only now, after every check that could be made without it.
	const value = await consumeSecureInput(env, input.requestId, input.instanceId, input.userId, { consumedNode: conn.runnerNode ?? null });
	if (value == null) return refuse("The value could not be claimed — it was used or expired a moment ago. Check secure_input_status.");
	const verifiedBy = hidden ? ("outcome" as const) : ("echo" as const);

	const restore = async (reason: string): Promise<SecureInjectResult> => {
		const restored = await restoreConsumedSecureInput(env, input.requestId, input.userId, value).catch(() => false);
		return {
			...base,
			verifiedBy,
			delivered: false,
			reason: `${reason} ${restored ? "The value was NOT consumed — it is still ready; fix the target and inject again." : "The value could not be restored; ask the owner to enter it again."}`,
			consumedValue: !restored,
			status: restored ? "ready" : "consumed",
		};
	};

	let typed: SendResult;
	try {
		typed = await pane.send({ text: value });
	} catch (e) {
		return restore(`Typing into "${target}" failed: ${errorText(e, value)}.`);
	}

	if (hidden) return finishHidden(pane, target, before ?? "", value, { ...base, verifiedBy }, restore);

	const needle = value.trim();
	if (occurrences(typed.pane ?? "", needle) <= occurrences(typed.paneBefore ?? "", needle)) {
		// Whatever reached the line is cleared, so a retry cannot double it — and nothing is submitted.
		await pane.send({ keys: ["C-u"] }).catch(() => undefined);
		return restore(
			`The value did not appear on "${target}"'s prompt line after typing — the session may not be at an input prompt. (A password prompt is detected from a trailing "Password:"/"passphrase" line; pass hidden_prompt:true to insist on one.)`,
		);
	}

	let submitted = false;
	if (input.submit) {
		try {
			await pane.send({ keys: ["Enter"] });
			submitted = true;
		} catch {
			return { ...base, verifiedBy, delivered: true, submitted: false, consumedValue: true, status: "consumed", reason: `The value is on "${target}"'s prompt line, but pressing Enter failed — press it with tmux_send_keys.` };
		}
	}
	return { ...base, verifiedBy, delivered: true, submitted, consumedValue: true, status: "consumed", scrubbed: await scrubDelivered(conn, target, value) };
}

/** Enter, then judge the password prompt by what it does next (#1140). The value is already typed. */
async function finishHidden(
	pane: Pane,
	target: string,
	before: string,
	value: string,
	base: Omit<SecureInjectResult, "delivered" | "consumedValue" | "status">,
	restore: (reason: string) => Promise<SecureInjectResult>,
): Promise<SecureInjectResult> {
	let entered: SendResult;
	try {
		entered = await pane.send({ keys: ["Enter"] });
	} catch (e) {
		// Not submitted: what was typed is cleared off the hidden line, and the value restored.
		await pane.send({ keys: ["C-u"] }).catch(() => undefined);
		return restore(`The value was typed at "${target}"'s password prompt, but pressing Enter failed (${errorText(e, value)}); the line was cleared.`);
	}
	const spent = { ...base, submitted: true, consumedValue: true, status: "consumed" };
	const verdict = await watchHiddenOutcome(before, entered.pane ?? "", () => pane.capture());
	if (verdict.kind === "accepted") return { ...spent, delivered: true };
	const seconds = Math.round(hiddenOutcomeTiming.windowMs / 1000);
	if (verdict.kind === "waiting") {
		// Unknown, not refused: a slow login is not interrupted. The operator looks before acting.
		return { ...spent, delivered: false, reason: `The value was submitted at "${target}"'s password prompt, but nothing followed within ${seconds}s — it may still be checking. Capture the pane before doing anything else. The value was consumed.` };
	}
	// Rejected: the prompt is abandoned so nothing else gets typed into it.
	await pane.send({ keys: ["C-c"] }).catch(() => undefined);
	const why = verdict.kind === "rejected" ? `the program answered "${verdict.why}"` : "the program asked for the secret again";
	return {
		...spent,
		delivered: false,
		reason: `The value was submitted at "${target}"'s password prompt and rejected — ${why}. C-c was sent to abandon the prompt. The value was consumed (it was submitted); ask the owner for the correct one with a new secure_input_request.`,
	};
}
