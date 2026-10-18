/**
 * #966 — `secure_input_inject` delivers into a NAMED tmux pane and says whether it got there.
 *
 * Over the real schema, through the real routes. Only the relay is faked: a tiny tmux whose prompt
 * line echoes what is typed (as `gcloud auth login --no-launch-browser`'s did), with the knobs the
 * 2026-10-08 failure needs — a session that is not at a prompt, and one that does not exist.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getBoundRunnerConn, callRunner } = vi.hoisted(() => ({ getBoundRunnerConn: vi.fn(), callRunner: vi.fn() }));
vi.mock("../lib/runner-client.js", async (orig) => ({ ...(await orig<typeof import("../lib/runner-client.js")>()), getBoundRunnerConn, callRunner }));
vi.mock("../lib/auth.js", async (orig) => ({ ...(await orig<typeof import("../lib/auth.js")>()), requireUser: async () => ({ uid: "u1", roles: [] }) }));

import { HttpError } from "../lib/auth.js";
import { revokeConsent, setConsent } from "../lib/connector-consent.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { occurrences } from "../lib/secure-input-inject.js";
import type { Env } from "../types.js";

const { secureInputRoutes } = await import("./secure-input.js");

const CODE = "4/0AVG7fiQ-VERIFICATION-CODE-7f3a";
const PROMPT = "Once finished, enter the verification code provided in your browser: ";

let d1: RealSchemaD1;
let env: Env;
/** The fake machine: one pane per session; the last line is the prompt line. */
let panes: Map<string, string>;
/** A session whose foreground program ignores input (not at a prompt). */
let deaf: Set<string>;
let sent: Array<{ path: string; session: unknown; text?: unknown; keys?: unknown }>;
/** What `/secure/scrub` was asked to clear after a delivery (#1166), and whether every pane read asked for the raw pane. */
let scrubs: Array<{ target?: unknown; value?: unknown }>;
let maskedReads: number;
/** Values typed through `/secure/type` — the only route a secret may travel (#1143). */
let typedSecurely: unknown[];

beforeEach(async () => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	env = { DB: d1.DB, KEY_ENCRYPTION_KEY: "0".repeat(64) } as unknown as Env;
	// The owner granted terminal write consent, as `*_send_keys` needs (#1145).
	await setConsent(env, "i1", "u1", "tmux", "write");
	await setConsent(env, "i1", "u1", "terminal", "write");
	panes = new Map([["gcloud-setup", `$ gcloud auth login --no-launch-browser\nGo to the following link in your browser:\n  https://accounts.google.com/o/oauth2/auth?…\n\n${PROMPT}`]]);
	deaf = new Set();
	sent = [];
	scrubs = [];
	maskedReads = 0;
	typedSecurely = [];
	getBoundRunnerConn.mockReset().mockResolvedValue({ runnerNode: "pink-laptop", instanceId: "i1" });
	callRunner.mockReset().mockImplementation(async (_conn: unknown, realPath: string, raw: { session: string; text?: string; keys?: string[]; unmasked?: boolean; target?: string; value?: string }) => {
		// The secret is typed over `/secure/type` (#1143) — recorded under that path, with the pane effect of a send.
		const typing = realPath === "/secure/type";
		const path = typing ? "/tmux/send" : realPath;
		const body = typing ? { session: String(raw.target).replace(/^tmux:/, ""), text: raw.value, unmasked: true } : raw;
		if (typing) typedSecurely.push(raw.value);
		if (path === "/secure/scrub") {
			scrubs.push({ target: body.target, value: body.value });
			return { remembered: true, cleared: true };
		}
		if (body.unmasked !== true) maskedReads++;
		if (path === "/tmux/capture") {
			const pane = panes.get(body.session);
			if (pane === undefined) throw new Error(`Runner /tmux/capture → 404: {"error":"No tmux session \\"${body.session}\\"."}`);
			return { session: body.session, pane };
		}
		sent.push({ path: realPath, session: body.session, text: body.text, keys: body.keys });
		if (path !== "/tmux/send") throw new Error(`unexpected ${path}`);
		const before = panes.get(body.session);
		if (before === undefined) throw new Error(`Runner /tmux/send → 404: {"error":"No tmux session \\"${body.session}\\"."}`);
		let pane = before;
		if (!deaf.has(body.session)) {
			if (body.text != null) pane += body.text;
			for (const k of body.keys ?? []) {
				if (k === "Enter") pane += "\nYou are now logged in as [owner@example.com].\n$ ";
				if (k === "C-u") pane = pane.slice(0, pane.lastIndexOf("\n") + 1) + PROMPT;
			}
		}
		panes.set(body.session, pane);
		return { session: body.session, pane, paneBefore: before, changed: pane !== before };
	});
});
afterEach(() => d1.close());

async function call(method: string, path: string, body?: unknown) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", secureInputRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(`/v1/instances${path}`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
	const text = await res.text();
	// biome-ignore lint/suspicious/noExplicitAny: a JSON response read field by field in assertions.
	let json: Record<string, any> = {};
	try {
		json = JSON.parse(text);
	} catch {
		/* a bare 404 from the router is plain text */
	}
	return { status: res.status, text, body: json };
}

/** A tmux request the owner has answered with `value`. */
async function ready(value = CODE, target?: string) {
	const created = await call("POST", "/i1/secure-inputs", { label: "gcloud verification code", destinationScope: "tmux", ...(target ? { target } : {}) });
	const id = created.body.id as string;
	await call("POST", `/i1/secure-inputs/${id}/submit`, { value });
	return id;
}

describe("inject lands the value on the named session's prompt line, verified (#966)", () => {
	it("types it into `target`, confirms it on the pane, submits it — and the answer never carries the value", async () => {
		const id = await ready();
		const r = await call("POST", `/i1/secure-inputs/${id}/inject`, { target: "gcloud-setup" });
		expect(r.body).toEqual({ delivered: true, submitted: true, consumedValue: true, target: "gcloud-setup", status: "consumed", length: CODE.length, verifiedBy: "echo", scrubbed: { cleared: true, masked: true } });
		expect(r.text).not.toContain("VERIFICATION-CODE");
		// Capture: the code is on the prompt line, then Enter submitted it.
		const pane = panes.get("gcloud-setup") ?? "";
		expect(pane).toContain(`${PROMPT}${CODE}\nYou are now logged in`);
		expect(sent.map((s) => [s.path, s.session, s.keys ?? null])).toEqual([
			["/secure/type", "gcloud-setup", null],
			["/tmux/send", "gcloud-setup", ["Enter"]],
		]);
		expect((await call("GET", `/i1/secure-inputs/${id}`)).body.status).toBe("consumed");
	});

	it("submit:false leaves it on the line for the operator to check, and the request's own target is used", async () => {
		const id = await ready(CODE, "gcloud-setup");
		const r = await call("POST", `/i1/secure-inputs/${id}/inject`, { submit: false });
		expect(r.body).toMatchObject({ delivered: true, submitted: false, target: "gcloud-setup" });
		expect(panes.get("gcloud-setup")?.endsWith(`${PROMPT}${CODE}`)).toBe(true);
		expect(sent.some((s) => Array.isArray(s.keys))).toBe(false);
	});
});

describe("a delivery that is not confirmed never spends the secret (#966)", () => {
	it("a session not at a prompt: delivered:false with the reason, the line cleared, nothing submitted, the value still ready", async () => {
		deaf.add("gcloud-setup");
		const id = await ready();
		const r = await call("POST", `/i1/secure-inputs/${id}/inject`, { target: "gcloud-setup" });
		expect(r.body).toMatchObject({ delivered: false, submitted: false, consumedValue: false, status: "ready", reason: expect.stringMatching(/did not appear on "gcloud-setup"'s prompt line.*NOT consumed/) });
		expect(r.text).not.toContain("VERIFICATION-CODE");
		expect(sent.map((s) => s.keys ?? null)).toEqual([null, ["C-u"]]);
		expect((await call("GET", `/i1/secure-inputs/${id}`)).body.status).toBe("ready");
		// …so the SAME request delivers once the session is at its prompt.
		deaf.delete("gcloud-setup");
		expect((await call("POST", `/i1/secure-inputs/${id}/inject`, { target: "gcloud-setup" })).body).toMatchObject({ delivered: true, submitted: true });
	});

	it("a session that does not exist: the runner's reason, the value restored", async () => {
		const id = await ready();
		const r = await call("POST", `/i1/secure-inputs/${id}/inject`, { target: "gcloud-setpu" });
		expect(r.body).toMatchObject({ delivered: false, consumedValue: false, status: "ready", reason: expect.stringMatching(/No tmux session/) });
		expect((await call("GET", `/i1/secure-inputs/${id}`)).body.status).toBe("ready");
	});

	it("an earlier copy of the value already on screen does not count as this delivery", async () => {
		deaf.add("gcloud-setup");
		panes.set("gcloud-setup", `${PROMPT}${CODE}\nERROR: invalid code\n${PROMPT}`);
		const id = await ready();
		expect((await call("POST", `/i1/secure-inputs/${id}/inject`, { target: "gcloud-setup" })).body).toMatchObject({ delivered: false, consumedValue: false });
	});

	it("no target, no runner, or a request that is not ready: refused before anything is consumed", async () => {
		const id = await ready();
		expect((await call("POST", `/i1/secure-inputs/${id}/inject`, {})).body).toMatchObject({ delivered: false, consumedValue: false, reason: expect.stringMatching(/Name the tmux session/) });
		getBoundRunnerConn.mockResolvedValueOnce(null);
		expect((await call("POST", `/i1/secure-inputs/${id}/inject`, { target: "gcloud-setup" })).body).toMatchObject({ delivered: false, consumedValue: false, reason: expect.stringMatching(/pags up/) });
		const pending = (await call("POST", "/i1/secure-inputs", { label: "x", destinationScope: "tmux" })).body.id as string;
		expect((await call("POST", `/i1/secure-inputs/${pending}/inject`, { target: "gcloud-setup" })).body).toMatchObject({ delivered: false, reason: expect.stringMatching(/pending, not ready/) });
		expect(sent).toEqual([]);
		expect((await call("GET", `/i1/secure-inputs/${id}`)).body.status).toBe("ready");
	});
});

describe("status says what the value IS without showing it (#966)", () => {
	it("length, empty and leading/trailing whitespace once ready — never the value", async () => {
		const id = await ready(`${CODE}\n`);
		const s = await call("GET", `/i1/secure-inputs/${id}`);
		expect(s.body).toMatchObject({ status: "ready", length: CODE.length + 1, empty: false, hasLeadingTrailingWhitespace: true });
		expect(s.text).not.toContain("VERIFICATION-CODE");
		const pending = (await call("POST", "/i1/secure-inputs", { label: "x", destinationScope: "tmux" })).body.id as string;
		expect((await call("GET", `/i1/secure-inputs/${pending}`)).body).not.toHaveProperty("length");
	});

	it("the plaintext-returning /consume route is gone — no route answers a secret", async () => {
		const id = await ready();
		expect((await call("POST", `/i1/secure-inputs/${id}/consume`)).status).toBe(404);
		expect((await call("GET", `/i1/secure-inputs/${id}`)).body.status).toBe("ready");
	});

	it("a target is a tmux session name, and only a tmux request takes one", async () => {
		expect((await call("POST", "/i1/secure-inputs", { label: "x", destinationScope: "tmux", target: "a\nb" })).status).toBe(400);
		expect((await call("POST", "/i1/secure-inputs", { label: "x", destinationScope: "file", target: "s" })).status).toBe(400);
	});
});

describe("occurrences", () => {
	it("counts across a wrapped pane line", () => {
		expect(occurrences(`prompt: 4/0AVG7f\niQ-rest`, "4/0AVG7fiQ-rest")).toBe(1);
		expect(occurrences("ab ab", "ab")).toBe(2);
		expect(occurrences("x", "")).toBe(0);
	});
});

describe("inject is held to the terminal write-consent *_send_keys needs (#1145)", () => {
	it("without the tmux consent: refused with the consent route named, the runner never reached, the value still ready", async () => {
		await revokeConsent(env, "i1", "tmux", "write");
		const id = await ready();
		const r = await call("POST", `/i1/secure-inputs/${id}/inject`, { target: "gcloud-setup" });
		expect(r.body).toMatchObject({ delivered: false, consumedValue: false, submitted: false, status: "ready" });
		expect(r.body.reason).toContain("PUT /v1/instances/i1/connectors/tmux/consent");
		expect(r.body.reason).toContain("Nothing was consumed.");
		expect(callRunner).not.toHaveBeenCalled();
		expect((await call("GET", `/i1/secure-inputs/${id}`)).body.status).toBe("ready");
	});

	it("a per-call (ask) consent is refused too — inject cannot be queued for approval", async () => {
		await setConsent(env, "i1", "u1", "tmux", "write", "ask");
		const id = await ready();
		const r = await call("POST", `/i1/secure-inputs/${id}/inject`, { target: "gcloud-setup" });
		expect(r.body).toMatchObject({ delivered: false, consumedValue: false, status: "ready" });
		expect(r.body.reason).toContain("ask on every call");
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("a prefixed target needs the terminal connector's consent — tmux consent alone does not reach /terminal/send", async () => {
		await revokeConsent(env, "i1", "terminal", "write");
		const id = await ready();
		const r = await call("POST", `/i1/secure-inputs/${id}/inject`, { target: "tmux:gcloud-setup" });
		expect(r.body).toMatchObject({ delivered: false, consumedValue: false, status: "ready" });
		expect(r.body.reason).toContain("PUT /v1/instances/i1/connectors/terminal/consent");
		expect(callRunner).not.toHaveBeenCalled();
	});
});

describe("an echoed value does not stay in the pane for the next reader (#1166)", () => {
	it("after delivery the runner is asked to clear the scrollback and mask the value — and the answer still never carries it", async () => {
		const id = await ready();
		const r = await call("POST", `/i1/secure-inputs/${id}/inject`, { target: "gcloud-setup" });
		expect(r.body).toMatchObject({ delivered: true, scrubbed: { cleared: true, masked: true } });
		expect(scrubs).toEqual([{ target: "gcloud-setup", value: CODE }]);
		expect(r.text).not.toContain("VERIFICATION-CODE");
	});

	it("inject reads its OWN panes unmasked — it must see the value land — and nothing else it sends asks for that", async () => {
		const id = await ready();
		await call("POST", `/i1/secure-inputs/${id}/inject`, { target: "gcloud-setup" });
		expect(maskedReads).toBe(0);
	});

	it("a delivery that did not land is not scrubbed — nothing was left behind, and the value is restored", async () => {
		deaf.add("gcloud-setup");
		const id = await ready();
		const r = await call("POST", `/i1/secure-inputs/${id}/inject`, { target: "gcloud-setup" });
		expect(r.body).toMatchObject({ delivered: false, status: "ready" });
		expect(scrubs).toEqual([]);
	});

	it("a runner older than the scrub still delivers; the answer says the pane was not scrubbed", async () => {
		const real = callRunner.getMockImplementation();
		callRunner.mockImplementation(async (conn: unknown, path: string, body: never) => {
			if (path === "/secure/scrub") throw new Error('Runner /secure/scrub → 404: {"error":"Not found"}');
			return real?.(conn, path, body);
		});
		const id = await ready();
		const r = await call("POST", `/i1/secure-inputs/${id}/inject`, { target: "gcloud-setup" });
		expect(r.body).toMatchObject({ delivered: true, scrubbed: { cleared: false, masked: false } });
	});
});

describe("the secret is typed over the runner's stdin path, never as send-keys text (#1143)", () => {
	it("it goes to /secure/type — and no /tmux/send ever carries it", async () => {
		const id = await ready();
		await call("POST", `/i1/secure-inputs/${id}/inject`, { target: "gcloud-setup" });
		expect(typedSecurely).toEqual([CODE]);
		expect(sent.filter((s) => s.path === "/tmux/send").some((s) => String(s.text ?? "").includes(CODE))).toBe(false);
	});

	it("a runner without /secure/type is REFUSED, not fallen back from — the value restored, nothing typed", async () => {
		const real = callRunner.getMockImplementation();
		callRunner.mockImplementation(async (conn: unknown, path: string, body: never) => {
			if (path === "/secure/type") throw new Error('Runner /secure/type → 404: {"error":"Not found"}');
			return real?.(conn, path, body);
		});
		const id = await ready();
		const r = await call("POST", `/i1/secure-inputs/${id}/inject`, { target: "gcloud-setup" });
		expect(r.body).toMatchObject({ delivered: false, consumedValue: false, status: "ready" });
		expect(r.body.reason).toMatch(/CLI 0\.4\.159 or newer/);
		expect(sent.some((s) => String(s.text ?? "").includes(CODE))).toBe(false);
	});
});
