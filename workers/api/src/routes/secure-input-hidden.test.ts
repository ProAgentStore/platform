/**
 * #1140 — `secure_input_inject` delivers to a password prompt, verified by what the prompt does next.
 *
 * Over the real schema, through the real routes. Only the relay is faked: a tiny machine whose
 * password prompts hide what is typed (as ssh's and sudo's do), answering Enter with a login, a
 * "Permission denied" re-prompt, or — the ssh shape — nothing for a moment and THEN the rejection.
 * The same panes are reachable as bare tmux sessions and as `tmux:` terminal targets.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getBoundRunnerConn, callRunner } = vi.hoisted(() => ({ getBoundRunnerConn: vi.fn(), callRunner: vi.fn() }));
vi.mock("../lib/runner-client.js", async (orig) => ({ ...(await orig<typeof import("../lib/runner-client.js")>()), getBoundRunnerConn, callRunner }));
vi.mock("../lib/auth.js", async (orig) => ({ ...(await orig<typeof import("../lib/auth.js")>()), requireUser: async () => ({ uid: "u1", roles: [] }) }));

import { HttpError } from "../lib/auth.js";
import { setConsent } from "../lib/connector-consent.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { hiddenOutcomeTiming, judgeHiddenOutcome, outputAfterPrompt, trailingSecretPrompt } from "../lib/secure-input-hidden.js";
import type { Env } from "../types.js";

const { secureInputRoutes } = await import("./secure-input.js");

const SECRET = "hunter2-Correct-Horse";
const SSH_PROMPT = "serge@pink-laptop's password: ";
const SUDO_PROMPT = "[sudo] password for serge: ";

interface Session {
	pane: string;
	/** The prompt line it asks with, or null for a plain shell (no prompt to type a password at). */
	prompt: string | null;
	/** What the hidden line holds — never painted. */
	buffer: string;
	password: string;
	rejection: string;
	/** Captures that show nothing after a wrong Enter before the rejection appears (ssh's delay). */
	slow: number;
	pendingRejection: number | null;
}

let d1: RealSchemaD1;
let env: Env;
let machine: Map<string, Session>;
let sent: Array<{ path: string; target: unknown; text?: unknown; keys?: unknown }>;

function session(over: Partial<Session> & { pane: string }): Session {
	return { prompt: null, buffer: "", password: SECRET, rejection: "Permission denied, please try again.", slow: 0, pendingRejection: null, ...over };
}

function capture(s: Session): string {
	if (s.pendingRejection !== null && --s.pendingRejection <= 0) {
		s.pendingRejection = null;
		s.pane += `\n${s.rejection}\n${s.prompt}`;
	}
	return s.pane;
}

beforeEach(async () => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	env = { DB: d1.DB, KEY_ENCRYPTION_KEY: "0".repeat(64) } as unknown as Env;
	// The owner granted terminal write consent, as `*_send_keys` needs (#1145).
	await setConsent(env, "i1", "u1", "tmux", "write");
	await setConsent(env, "i1", "u1", "terminal", "write");
	machine = new Map([
		["ssh-pink", session({ pane: `$ ssh serge@pink-laptop\n${SSH_PROMPT}`, prompt: SSH_PROMPT })],
		["sudo", session({ pane: `$ sudo systemctl restart pags-runner\n${SUDO_PROMPT}`, prompt: SUDO_PROMPT, rejection: "Sorry, try again." })],
		["shell", session({ pane: "serge@dell-laptop:~$ " })],
	]);
	sent = [];
	Object.assign(hiddenOutcomeTiming, { windowMs: 60, pollMs: 5 });
	getBoundRunnerConn.mockReset().mockResolvedValue({ runnerNode: "dell-laptop", instanceId: "i1" });
	callRunner.mockReset().mockImplementation(async (_conn: unknown, path: string, body: { session?: string; target?: string; text?: string; keys?: string[] }) => {
		const name = path.startsWith("/terminal/") ? String(body.target).replace(/^tmux:/, "") : String(body.session);
		const s = machine.get(name);
		if (!s) throw new Error(`Runner ${path} → 404: {"error":"No tmux session \\"${name}\\"."}`);
		if (path.endsWith("/capture")) return { pane: capture(s) };
		if (!path.endsWith("/send")) throw new Error(`unexpected ${path}`);
		sent.push({ path, target: body.target ?? body.session, text: body.text, keys: body.keys });
		const before = s.pane;
		const atPrompt = s.prompt !== null && s.pane.endsWith(s.prompt);
		if (body.text != null) {
			if (atPrompt) s.buffer += body.text; // hidden: nothing is painted
			else s.pane += body.text;
		}
		for (const k of body.keys ?? []) {
			if (k === "C-u") s.buffer = "";
			if (k === "C-c") s.pane += "^C\nserge@dell-laptop:~$ ";
			if (k === "Enter" && atPrompt) {
				const ok = s.buffer === s.password;
				s.buffer = "";
				s.pane += "\n";
				if (ok) s.pane += "Welcome to pink-laptop\nserge@pink-laptop:~$ ";
				else if (s.slow > 0) s.pendingRejection = s.slow;
				else s.pane += `${s.rejection}\n${s.prompt}`;
			}
		}
		return { pane: s.pane, paneBefore: before, changed: s.pane !== before };
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
		/* plain-text 404 */
	}
	return { status: res.status, text, body: json };
}

async function ready(value = SECRET) {
	const id = (await call("POST", "/i1/secure-inputs", { label: "pink-laptop ssh password", destinationScope: "tmux" })).body.id as string;
	await call("POST", `/i1/secure-inputs/${id}/submit`, { value });
	return id;
}

const statusOf = async (id: string) => (await call("GET", `/i1/secure-inputs/${id}`)).body.status;

describe("a hidden prompt is verified by its outcome, not by echo (#1140)", () => {
	it("success: detected from the pane, typed, submitted, accepted — and the value is nowhere in the answer", async () => {
		const id = await ready();
		const r = await call("POST", `/i1/secure-inputs/${id}/inject`, { target: "ssh-pink" });
		expect(r.body).toEqual({ delivered: true, verifiedBy: "outcome", submitted: true, consumedValue: true, target: "ssh-pink", status: "consumed", length: SECRET.length });
		expect(r.text).not.toContain(SECRET);
		expect(machine.get("ssh-pink")?.pane).toContain("Welcome to pink-laptop");
		expect(machine.get("ssh-pink")?.pane).not.toContain(SECRET);
		expect(sent.map((s) => s.keys ?? "text")).toEqual(["text", ["Enter"]]);
		expect(await statusOf(id)).toBe("consumed");
	});

	it("success with hidden_prompt:true, over a `tmux:` terminal target (the terminal_* connector's paths)", async () => {
		const id = await ready();
		const r = await call("POST", `/i1/secure-inputs/${id}/inject`, { target: "tmux:sudo", hiddenPrompt: true });
		expect(r.body).toMatchObject({ delivered: true, verifiedBy: "outcome", submitted: true, target: "tmux:sudo" });
		expect(sent.every((s) => s.path === "/terminal/send" && s.target === "tmux:sudo")).toBe(true);
	});

	it("wrong password: delivered:false naming the rejection, C-c sent, and the value reported consumed because it was submitted", async () => {
		const id = await ready("not-the-password");
		const r = await call("POST", `/i1/secure-inputs/${id}/inject`, { target: "sudo" });
		expect(r.body).toMatchObject({ delivered: false, verifiedBy: "outcome", submitted: true, consumedValue: true, status: "consumed" });
		expect(r.body.reason).toMatch(/rejected — the program answered "Sorry, try again".*C-c was sent.*consumed \(it was submitted\)/);
		expect(r.text).not.toContain("not-the-password");
		expect(sent.map((s) => s.keys ?? "text")).toEqual(["text", ["Enter"], ["C-c"]]);
		expect(await statusOf(id)).toBe("consumed");
	});

	it("wrong password, ssh-style: the rejection arrives only after a pause and is still caught inside the window", async () => {
		const ssh = machine.get("ssh-pink");
		if (ssh) ssh.slow = 3;
		const id = await ready("not-the-password");
		const r = await call("POST", `/i1/secure-inputs/${id}/inject`, { target: "ssh-pink" });
		expect(r.body).toMatchObject({ delivered: false, submitted: true, consumedValue: true, reason: expect.stringMatching(/Permission denied/) });
		expect(sent.at(-1)?.keys).toEqual(["C-c"]);
	});

	it("no prompt + hidden_prompt:true: refused before anything is consumed or typed", async () => {
		const id = await ready();
		const r = await call("POST", `/i1/secure-inputs/${id}/inject`, { target: "shell", hiddenPrompt: true });
		expect(r.body).toMatchObject({ delivered: false, consumedValue: false, submitted: false, status: "ready", reason: expect.stringMatching(/does not end with a password or passphrase prompt.*Nothing was consumed/) });
		expect(sent).toEqual([]);
		expect(await statusOf(id)).toBe("ready");
	});

	it("a password prompt with submit:false is refused unconsumed — it could never be verified", async () => {
		const id = await ready();
		const r = await call("POST", `/i1/secure-inputs/${id}/inject`, { target: "ssh-pink", submit: false });
		expect(r.body).toMatchObject({ delivered: false, consumedValue: false, reason: expect.stringMatching(/submit:false cannot be honoured/) });
		expect(sent).toEqual([]);
	});

	it("a prompt that never answers is reported unconfirmed, not rejected — no C-c into a login that may be slow", async () => {
		const ssh = machine.get("ssh-pink");
		if (ssh) ssh.slow = 10_000;
		const id = await ready("not-the-password");
		const r = await call("POST", `/i1/secure-inputs/${id}/inject`, { target: "ssh-pink" });
		expect(r.body).toMatchObject({ delivered: false, submitted: true, consumedValue: true, reason: expect.stringMatching(/nothing followed within/) });
		expect(sent.some((s) => Array.isArray(s.keys) && s.keys.includes("C-c"))).toBe(false);
	});

	it("hiddenPrompt:false forces the echo check, which a hidden prompt fails — cleared and restored", async () => {
		const id = await ready();
		const r = await call("POST", `/i1/secure-inputs/${id}/inject`, { target: "ssh-pink", hiddenPrompt: false });
		expect(r.body).toMatchObject({ delivered: false, verifiedBy: "echo", consumedValue: false, status: "ready" });
		expect(sent.map((s) => s.keys ?? "text")).toEqual(["text", ["C-u"]]);
		expect(machine.get("ssh-pink")?.buffer).toBe("");
	});

	it("a non-boolean hiddenPrompt is a 400", async () => {
		const id = await ready();
		expect((await call("POST", `/i1/secure-inputs/${id}/inject`, { target: "ssh-pink", hiddenPrompt: "yes" })).status).toBe(400);
	});
});

describe("terminal targets keep the terminal connector's limits (#1140)", () => {
	it("iTerm2 is refused unconsumed — it cannot hold a value unsubmitted or take C-c", async () => {
		const id = await ready();
		const r = await call("POST", `/i1/secure-inputs/${id}/inject`, { target: "iterm2:1:1:1" });
		expect(r.body).toMatchObject({ delivered: false, consumedValue: false, reason: expect.stringMatching(/iTerm2/) });
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("a backend outside the agent's declared ceiling is refused before the runner is reached", async () => {
		d1.exec(`UPDATE agents SET config = '{"capabilities":{"surfaceOptions":{"terminal":{"backends":["kitty"]}}}}' WHERE id = 'agent-1'`);
		const id = await ready();
		const r = await call("POST", `/i1/secure-inputs/${id}/inject`, { target: "tmux:ssh-pink" });
		expect(r.body).toMatchObject({ delivered: false, consumedValue: false, reason: expect.stringMatching(/capability constraint.*Nothing was consumed/) });
		expect(callRunner).not.toHaveBeenCalled();
		expect(await statusOf(id)).toBe("ready");
	});

	it("a `tmux:` prefix is not a way around a tmux Operator's bound session", async () => {
		d1.exec(`UPDATE agents SET config = '{"capabilities":{"surfaces":["tmux"],"surfaceOptions":{"tmux":{"sessions":"single"}}}}' WHERE id = 'agent-1'`);
		d1.exec(`UPDATE agent_instances SET config = '{"surfaceOptions":{"tmux":{"boundSession":"ssh-pink"}}}' WHERE id = 'i1'`);
		const id = await ready();
		for (const target of ["tmux:sudo", "sudo"]) {
			const r = await call("POST", `/i1/secure-inputs/${id}/inject`, { target });
			expect(r.body, target).toMatchObject({ delivered: false, consumedValue: false, reason: expect.stringMatching(/Nothing was consumed/) });
		}
		expect(callRunner).not.toHaveBeenCalled();
		expect((await call("POST", `/i1/secure-inputs/${id}/inject`, { target: "tmux:ssh-pink" })).body).toMatchObject({ delivered: true });
	});
});

describe("reading a password prompt", () => {
	it("recognises the prompts ssh, sudo, su and ssh-agent print — and not a shell or a code prompt", () => {
		for (const p of [SSH_PROMPT, SUDO_PROMPT, "Password: ", "Enter passphrase for key '/home/serge/.ssh/id_ed25519': ", "Enter PIN for 'YubiKey':"]) {
			expect(trailingSecretPrompt(`$ cmd\n${p}`), p).not.toBeNull();
		}
		for (const p of ["serge@dell-laptop:~$ ", "Enter the verification code provided in your browser: ", `${SSH_PROMPT}\nWelcome\n$ `]) {
			expect(trailingSecretPrompt(p), p).toBeNull();
		}
	});

	it("output after the prompt ignores what is on the prompt's own row and survives an earlier identical prompt", () => {
		const before = `$ sudo x\n${SUDO_PROMPT}\nSorry, try again.\n${SUDO_PROMPT}`;
		expect(outputAfterPrompt(before, `${before}********\n`)).toBe("");
		expect(judgeHiddenOutcome(before, `${before}\nSorry, try again.\n${SUDO_PROMPT}`)).toEqual({ kind: "rejected", why: "Sorry, try again" });
		expect(judgeHiddenOutcome(`$ ssh h\n${SSH_PROMPT}`, `$ ssh h\n${SSH_PROMPT}\n${SSH_PROMPT}`)).toMatchObject({ kind: "reprompted" });
		expect(judgeHiddenOutcome(`$ ssh h\n${SSH_PROMPT}`, `$ ssh h\n${SSH_PROMPT}\nLast login: today\nh$ `)).toEqual({ kind: "accepted" });
	});
});
