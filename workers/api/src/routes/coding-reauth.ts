/**
 * The engine re-auth relay (#881): sign a coding engine in from any device.
 *
 *   POST   /:instanceId/coding/engine-reauth         start the engine's subscription login on the runner
 *   GET    /:instanceId/coding/engine-reauth         read it: URL, device code, and whether it finished
 *   POST   /:instanceId/coding/engine-reauth/input   relay the code from the sign-in page (or a menu key)
 *   DELETE /:instanceId/coding/engine-reauth         stop it and close its terminal
 *
 * What login runs and why it lands where the engine reads it is `lib/engine-reauth.ts`; the record a
 * parked run waits on is `lib/engine-reauth-store.ts`.
 *
 * Built on the runner's existing `/tmux/*` endpoints rather than a new runner route, so it works on
 * runners already in the field — the machines this exists for are exactly the ones nobody is sitting
 * at to update. The login runs in a dedicated tmux session: a SHELL is started first and the login
 * runs inside it, so a CLI that exits after printing its result (`claude setup-token` prints the
 * token and exits) leaves that result readable instead of taking the pane with it. The session is
 * killed as soon as the login is read, which also removes the token from the scrollback.
 *
 * Owner-only (`requireOwned`) and fixed: the caller chooses the engine, never the command, and input
 * is limited to a sign-in code or a menu keystroke into that one session.
 */
import type { Context, Hono } from "hono";
import { HttpError } from "../lib/auth.js";
import { deriveClientType, engineAuthFor, readEngines } from "../lib/coding-engines.js";
import type { CodingClientType } from "../lib/coding-types.js";
import {
	type ReauthMethod,
	type ReauthPaneReading,
	extractSetupToken,
	planReauth,
	reauthInputError,
	reauthNextStep,
	reauthSessionName,
	readReauthPane,
	redactPane,
	subscriptionMenuChoice,
} from "../lib/engine-reauth.js";
import { type EngineReauthState, readReauthState, writeReauthState } from "../lib/engine-reauth-store.js";
import type { EngineAuthResolved } from "../lib/usage-payer.js";
import { logEvent } from "../lib/events.js";
import { READ_TIMEOUT_MS, type RunnerConn, callRunner, getBoundRunnerConn } from "../lib/runner-client.js";
import { hasUserProviderKey, upsertUserProviderKey } from "../lib/user-api-key-store.js";
import { notifyUser } from "./push.js";
import { requireOwned } from "./coding-shared.js";
import type { Env } from "../types.js";

/** How much of the login pane a caller sees — enough for a menu or an error, redacted. */
const PANE_TAIL_LINES = 30;
/** How far back a run stopped on sign-in is still worth offering to continue. */
const RESUMABLE_WINDOW_MS = 24 * 60 * 60 * 1000;
const RELAY_CLIENTS: readonly CodingClientType[] = ["claude", "codex"];

type Ctx = Context<{ Bindings: Env }>;

async function requireConn(c: Ctx, instanceId: string, uid: string): Promise<RunnerConn> {
	const conn = await getBoundRunnerConn(c.env, instanceId, uid).catch(() => null);
	if (!conn) throw new HttpError(409, "No runner connected — the sign-in runs on the runner, so it has to be online (pags up).");
	return conn;
}

/** Runner call that names an old runner instead of failing with a bare 404. */
async function tmux<T>(conn: RunnerConn, path: string, body: unknown): Promise<T> {
	try {
		return await callRunner<T>(conn, path, body, { timeoutMs: 20_000 });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (msg.includes(`${path} → 404`) && msg.includes("Not found")) {
			throw new HttpError(409, "This runner predates the terminal connector the sign-in relay drives. Update the runner (runner_update), then try again.");
		}
		throw e;
	}
}

async function capture(conn: RunnerConn, session: string): Promise<string | null> {
	const r = await callRunner<{ pane?: string }>(conn, "/tmux/capture", { session, lines: 400 }, { timeoutMs: READ_TIMEOUT_MS }).catch((e: unknown) => {
		// The session is gone — killed, or the machine restarted. Not an error to the caller: the
		// relay reports it as over.
		if (e instanceof Error && e.message.includes("→ 404")) return null;
		throw e;
	});
	return r ? String(r.pane ?? "") : null;
}

/** The engine a relay is for: the one named, else the instance's default engine's client. */
async function resolveEngine(env: Env, instanceId: string, uid: string, requested: unknown) {
	const { engines, defaultEngineId } = await readEngines(env, instanceId, uid);
	const clientType: CodingClientType | null =
		typeof requested === "string" && requested
			? ((RELAY_CLIENTS as readonly string[]).includes(requested) ? (requested as CodingClientType) : null)
			: deriveClientType(engines.find((e) => e.id === defaultEngineId)?.command ?? "claude");
	if (!clientType) throw new HttpError(400, `\`clientType\` must be one of: ${RELAY_CLIENTS.join(", ")}.`);
	// The preset whose sign-in mode decides where the engine reads its credential: the default when
	// it is this client, else the first preset for it.
	const preset =
		[engines.find((e) => e.id === defaultEngineId), ...engines].find((e) => e && deriveClientType(e.command) === clientType) ?? null;
	return { clientType, auth: engineAuthFor(engines, preset?.command ?? null) };
}

/** What the runner last saw the engine resolve, for the `machine`-mode shadow warning. Best-effort. */
async function lastAuthResolved(conn: RunnerConn, clientType: CodingClientType): Promise<EngineAuthResolved | null> {
	const diag = await callRunner<{ tracked?: Array<{ clientType?: string; authResolved?: EngineAuthResolved }> }>(conn, "/coding/diagnostics", undefined, {
		timeoutMs: READ_TIMEOUT_MS,
	}).catch(() => null);
	return diag?.tracked?.find((t) => t.clientType === clientType && t.authResolved)?.authResolved ?? null;
}

/** Runs on this instance that stopped on sign-in recently, newest first — the ones to continue. */
async function stoppedOnSignIn(env: Env, instanceId: string, uid: string): Promise<string[]> {
	const { results } = await env.DB.prepare(
		"SELECT run_id FROM agent_loop_runs WHERE instance_id = ?1 AND user_id = ?2 AND stop_reason = 'engine_auth' AND finished_at >= ?3 ORDER BY finished_at DESC LIMIT 5",
	)
		.bind(instanceId, uid, Date.now() - RESUMABLE_WINDOW_MS)
		.all<{ run_id: string }>();
	return (results ?? []).map((r) => r.run_id);
}

function tail(pane: string): string {
	return redactPane(pane).split("\n").slice(-PANE_TAIL_LINES).join("\n").trim();
}

/**
 * Read the login session and move the record on: pick the subscription option in a menu, store a
 * fresh setup-token, close a finished session. Shared by status and input so both answer alike.
 */
async function advance(
	c: Ctx,
	conn: RunnerConn,
	instanceId: string,
	uid: string,
	state: EngineReauthState,
	pane: string | null,
): Promise<{ state: EngineReauthState; reading: ReauthPaneReading | null; pane: string; resumableRuns: string[]; error?: string }> {
	if (pane === null) {
		// The login's terminal is gone before it finished — nothing left to read or drive.
		const next: EngineReauthState = { ...state, status: "failed", completedAt: Date.now() };
		await writeReauthState(c.env, instanceId, uid, next);
		return { state: next, reading: null, pane: "", resumableRuns: [], error: "The sign-in terminal on the runner is gone. Start the sign-in again." };
	}
	let reading = readReauthPane(pane, state.method);

	if (reading.state === "menu" && state.method === "claude-login") {
		// Only the subscription option, and only when it is the highlighted one — the relay never
		// guesses at a menu it cannot read (see `subscriptionMenuChoice`).
		const choice = subscriptionMenuChoice(pane);
		const highlighted = pane.split("\n").find((l) => /^\s*[❯>›]/.test(l) && /subscription/i.test(l));
		if (choice && highlighted) {
			const sent = await tmux<{ pane?: string }>(conn, "/tmux/send", { session: state.session, keys: ["Enter"] });
			pane = String(sent.pane ?? pane);
			reading = readReauthPane(pane, state.method);
		}
	}

	let error: string | undefined;
	let next = state;
	if (reading.state === "succeeded") {
		if (state.method === "claude-setup-token") {
			const token = extractSetupToken(pane);
			if (!token) {
				error = "The CLI reported a token, but it could not be read off the terminal. Start the sign-in again.";
				next = { ...state, status: "failed", completedAt: Date.now() };
			} else {
				await upsertUserProviderKey(c.env, uid, "claude-code", token);
				next = { ...state, status: "succeeded", completedAt: Date.now() };
			}
		} else {
			next = { ...state, status: "succeeded", completedAt: Date.now() };
		}
	} else if (reading.state === "failed") {
		next = { ...state, status: "failed", completedAt: Date.now() };
	}

	let resumableRuns: string[] = [];
	if (next !== state) {
		await writeReauthState(c.env, instanceId, uid, next);
		// Close the login terminal: a finished login has nothing more to say, and a setup-token
		// session holds the token in its scrollback.
		await callRunner(conn, "/tmux/session", { action: "kill", session: state.session }).catch(() => undefined);
		if (next.status === "succeeded") {
			resumableRuns = await stoppedOnSignIn(c.env, instanceId, uid).catch(() => []);
			const more = resumableRuns.length
				? ` ${resumableRuns.length} run(s) that stopped waiting on sign-in can be continued (continue_instance_run).`
				: " A run parked on sign-in continues by itself.";
			await notifyUser(c.env, uid, "coding", "🔑 Coding engine signed in", `The ${state.clientType} engine is signed in again.${more}`, undefined, {
				key: `coding-reauth-done:${instanceId}:${next.completedAt}`,
				instanceId,
			}).catch(() => undefined);
		}
		await logEvent(c.env, {
			source: "coding",
			event: "engine_reauth",
			message: `Engine re-auth ${next.status} (${state.clientType}, ${state.method})`,
			userId: uid,
			instanceId,
			context: { clientType: state.clientType, method: state.method, status: next.status, runnerNode: state.runnerNode },
		}).catch(() => undefined);
	}
	return { state: next, reading, pane, resumableRuns, error };
}

function respond(c: Ctx, r: Awaited<ReturnType<typeof advance>>, extra: Record<string, unknown> = {}) {
	const method: ReauthMethod = r.state.method;
	return c.json({
		status: r.state.status,
		clientType: r.state.clientType,
		method,
		runnerNode: r.state.runnerNode,
		// While pending, what the CLI is showing; `null` once the terminal is gone.
		loginState: r.reading?.state ?? null,
		url: r.reading?.url ?? null,
		deviceCode: r.reading?.deviceCode ?? null,
		nextStep: r.error ?? (r.reading ? reauthNextStep(r.reading, method) : null),
		startedAt: new Date(r.state.startedAt).toISOString(),
		completedAt: r.state.completedAt ? new Date(r.state.completedAt).toISOString() : null,
		resumableRuns: r.resumableRuns,
		pane: tail(r.pane),
		...extra,
	});
}

export function registerReauthRoutes(codingRoutes: Hono<{ Bindings: Env }>) {
	codingRoutes.post("/:instanceId/coding/engine-reauth", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const body = (await c.req.json().catch(() => ({}))) as { clientType?: unknown };
		const { clientType, auth } = await resolveEngine(c.env, instanceId, uid, body.clientType);
		const conn = await requireConn(c, instanceId, uid);
		const plan = planReauth({
			clientType,
			auth,
			hasStoredClaudeToken: clientType === "claude" ? await hasUserProviderKey(c.env, uid, "claude-code") : false,
			authResolved: auth === "machine" ? await lastAuthResolved(conn, clientType) : null,
		});
		if (!plan.ok) throw new HttpError(400, plan.reason);

		const session = reauthSessionName(clientType);
		// A fresh terminal every start: a stale login half-way through a flow is exactly the "stray
		// leftover login session blocking a fresh login" #881 records.
		await tmux(conn, "/tmux/session", { action: "kill", session }).catch(() => undefined);
		await tmux(conn, "/tmux/session", { session, workDir: "~" });
		const ran = await tmux<{ pane?: string }>(conn, "/tmux/run", { session, command: plan.command });

		const state: EngineReauthState = {
			clientType,
			method: plan.method,
			session,
			runnerNode: conn.runnerNode ?? null,
			status: "pending",
			startedAt: Date.now(),
			completedAt: null,
		};
		await writeReauthState(c.env, instanceId, uid, state);
		const r = await advance(c, conn, instanceId, uid, state, String(ran.pane ?? ""));
		return respond(c, r, { lands: plan.lands, warning: plan.warning });
	});

	codingRoutes.get("/:instanceId/coding/engine-reauth", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const state = await readReauthState(c.env, instanceId, uid);
		if (!state) return c.json({ status: "none", nextStep: 'No sign-in has been started. Start one with action "start".' });
		if (state.status !== "pending") {
			return respond(c, { state, reading: null, pane: "", resumableRuns: [] }, { nextStep: state.status === "succeeded" ? "Signed in." : `The last sign-in ${state.status}. Start a new one to try again.` });
		}
		const conn = await requireConn(c, instanceId, uid);
		return respond(c, await advance(c, conn, instanceId, uid, state, await capture(conn, state.session)));
	});

	codingRoutes.post("/:instanceId/coding/engine-reauth/input", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; keys?: unknown };
		const invalid = reauthInputError(body);
		if (invalid) throw new HttpError(400, invalid);
		const state = await readReauthState(c.env, instanceId, uid);
		if (state?.status !== "pending") throw new HttpError(409, 'No sign-in is waiting for input. Start one with action "start".');
		const conn = await requireConn(c, instanceId, uid);
		// A pasted code is submitted with Enter unless the caller named its own keys.
		const keys = Array.isArray(body.keys) ? (body.keys as string[]) : body.text != null ? ["Enter"] : [];
		const sent = await tmux<{ pane?: string }>(conn, "/tmux/send", { session: state.session, text: body.text ?? undefined, keys });
		// The code is exchanged over the network after Enter; read again rather than trusting the
		// settle snapshot, which can predate the CLI's verdict.
		const pane = (await capture(conn, state.session)) ?? String(sent.pane ?? "");
		return respond(c, await advance(c, conn, instanceId, uid, state, pane));
	});

	codingRoutes.delete("/:instanceId/coding/engine-reauth", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const state = await readReauthState(c.env, instanceId, uid);
		if (!state) return c.json({ status: "none" });
		const conn = await getBoundRunnerConn(c.env, instanceId, uid).catch(() => null);
		if (conn) await callRunner(conn, "/tmux/session", { action: "kill", session: state.session }).catch(() => undefined);
		const next: EngineReauthState = state.status === "pending" ? { ...state, status: "cancelled", completedAt: Date.now() } : state;
		if (next !== state) await writeReauthState(c.env, instanceId, uid, next);
		return c.json({ status: next.status, clientType: next.clientType });
	});
}
