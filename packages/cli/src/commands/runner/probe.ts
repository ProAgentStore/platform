// `pags runner probe` — prove a CLI release can run here BEFORE it replaces the running one (#1148).
//
// An update used to swap first and find out afterwards: the new payload went on trial (bootstrap/trial.ts) and was rolled back
// if it crashed or never registered. This is the stricter form beside it: the running `pags up` installs the candidate, runs
// THIS command from the candidate's own entry point as a separate short-lived process, and only goes on to swap when it passes.
//
// It checks, in order, that the candidate (1) loads and is the release that was asked for, (2) reaches the API with this
// machine's saved sign-in, and (3) can open a relay socket and get a round trip back. It takes NOTHING the running runner
// holds: no per-account runner lock, no instance's relay slot (the socket is a `probe=1` connection the Worker answers
// itself, never the instance's RelayDO), no local runtime port, and it registers and changes nothing. The trial window stays
// as the second line of defence for what only shows up under load.
import { hostname } from "node:os";
import { Command } from "commander";
import { writeLine } from "../../output.js";
import { loadSession } from "../login.js";
import { CLI_VERSION } from "./process.js";
import { apiPathSegment, pagsApiBase, requestPags } from "./http.js";

/** The line the parent reads back: the last stdout line starting with this, then a JSON {@link ProbeResult}. */
export const PROBE_MARKER = "PAGS_PROBE ";
export const PROBE_SOCKET_TIMEOUT_MS = 10_000;

export interface ProbeStep {
	name: "loads" | "session" | "relay";
	ok: boolean;
	detail: string;
}
export interface ProbeResult {
	ok: boolean;
	version: string;
	steps: ProbeStep[];
}

export interface ProbeDeps {
	version: string;
	/** The release the parent installed; a probe that finds itself to be another is not testing what was asked. */
	expect?: string;
	hasSession: () => boolean;
	/** The agents this account runs, by id — also the proof that the API accepts the sign-in. Throws when it does not. */
	listInstances: () => Promise<string[]>;
	mintRelayToken: (instanceId: string) => Promise<string>;
	/** Open the probe socket and return the round trip in ms. Throws when it cannot connect or no echo comes back. */
	roundTrip: (instanceId: string, token: string) => Promise<number>;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200);

export async function runProbe(deps: ProbeDeps): Promise<ProbeResult> {
	const steps: ProbeStep[] = [];
	const add = (name: ProbeStep["name"], ok: boolean, detail: string) => void steps.push({ name, ok, detail });

	if (deps.expect && deps.expect !== deps.version) add("loads", false, `started as ${deps.version}, not the ${deps.expect} that was installed`);
	else add("loads", true, `${deps.version} started`);

	let instances: string[] | null = null;
	if (!deps.hasSession()) add("session", false, "no saved sign-in on this machine (run `pags login`)");
	else {
		try {
			instances = await deps.listInstances();
			add("session", true, `the API accepted the saved sign-in (${instances.length} agent${instances.length === 1 ? "" : "s"})`);
		} catch (e) {
			add("session", false, `the API did not accept the saved sign-in: ${msg(e)}`);
		}
	}

	if (instances === null) add("relay", false, "not tried: the API could not be reached with the sign-in");
	else if (instances.length === 0) add("relay", true, "no agents to open a relay socket for; nothing to prove here");
	else {
		try {
			const token = await deps.mintRelayToken(instances[0]);
			const rtt = await deps.roundTrip(instances[0], token);
			add("relay", true, `a relay socket opened and answered in ${rtt}ms`);
		} catch (e) {
			add("relay", false, `could not open a relay socket: ${msg(e)}`);
		}
	}
	return { ok: steps.every((s) => s.ok), version: deps.version, steps };
}

/** A probe socket through the real WebSocket: connect, send one `rtt:` frame, wait for its echo, close. */
export function webSocketRoundTrip(wsBase: string, node: string, timeoutMs = PROBE_SOCKET_TIMEOUT_MS) {
	return (instanceId: string, token: string): Promise<number> =>
		new Promise<number>((resolve, reject) => {
			const url = `${wsBase}/v1/relay/${encodeURIComponent(instanceId)}/connect?${new URLSearchParams({ token, node, probe: "1" }).toString()}`;
			const ws = new WebSocket(url);
			const id = `probe-${Date.now().toString(36)}`;
			let sentAt = 0;
			const done = (fn: () => void) => {
				clearTimeout(timer);
				try { ws.close(); } catch { /* already closed */ }
				fn();
			};
			const timer = setTimeout(() => done(() => reject(new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`))), timeoutMs);
			ws.onopen = () => { sentAt = Date.now(); try { ws.send(`rtt:${id}`); } catch (e) { done(() => reject(e)); } };
			ws.onmessage = (event) => { if (String(event.data) === `rtt-echo:${id}`) done(() => resolve(Date.now() - sentAt)); };
			ws.onerror = () => done(() => reject(new Error("the connection was refused or dropped")));
			ws.onclose = () => done(() => reject(new Error("the connection closed before it answered")));
		});
}

export function probeCommand(): Command {
	return new Command("probe")
		.description("Check that this CLI release starts, reaches the API with the saved sign-in and can open a relay socket — without taking the runner lock or any agent's relay slot (used by auto-update before it swaps)")
		.option("--expect <version>", "Fail unless this CLI is exactly this version")
		.option("--api-base <url>", "PAGS API base URL")
		.action(async (opts: { expect?: string; apiBase?: string }) => {
			const api = { apiBase: opts.apiBase };
			const base = pagsApiBase(opts.apiBase);
			const result = await runProbe({
				version: CLI_VERSION,
				expect: opts.expect,
				hasSession: () => loadSession() !== null,
				listInstances: async () => {
					const r = await requestPags<{ instances?: Array<{ id?: unknown }> }>("GET", "/v1/instances/my/instances", api);
					return (r.instances ?? []).flatMap((i) => (typeof i.id === "string" ? [i.id] : []));
				},
				mintRelayToken: (id) => requestPags<{ token: string }>("POST", `/v1/relay/${apiPathSegment(id)}/token`, api, {}).then((r) => r.token),
				// A name no real machine registers under, so even an API that predates probe mode cannot disturb the machine's own socket.
				roundTrip: webSocketRoundTrip(base.replace(/^http/, "ws"), `pags-probe-${hostname()}`),
			});
			for (const s of result.steps) writeLine(`${s.ok ? "ok  " : "FAIL"} ${s.name}: ${s.detail}`);
			writeLine(`${PROBE_MARKER}${JSON.stringify(result)}`);
			process.exitCode = result.ok ? 0 : 1;
		});
}
