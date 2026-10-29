/**
 * #1131 — the sudo delivery through the real routes, on the real migrated schema. The machine is the only fake.
 *
 * The journey the owner's decision describes: an agent asks for a sudo password FOR a named command; the owner is shown that exact command and
 * approves it by submitting the value; the agent then asks the platform to deliver it — and can name no command of its own at any step.
 * What is pinned here is the door each step has: what is refused at creation, what the owner's submit must carry, and that the delivery
 * route takes nothing from its caller. How the delivery behaves once it runs is `lib/secure-input-sudo.test.ts`.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

let uid = "u1";
vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid, roles: [] }) };
});
vi.mock("./push.js", () => ({ notifyUser: async () => undefined }));
const { callRunner } = vi.hoisted(() => ({ callRunner: vi.fn() }));
vi.mock("../lib/runner-client.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/runner-client.js")>("../lib/runner-client.js");
	const conn = { kind: "relay", instanceId: "i1", runnerNode: "mini", relayName: "i1:node:mini" };
	return { ...actual, callRunner: (...a: unknown[]) => callRunner(...a), getBoundRunnerConn: async () => conn };
});

const { secureInputRoutes } = await import("./secure-input.js");

const PASSWORD = "c0rrect-h0rse-battery!";
const PMSET = ["pmset", "-a", "autorestart", "1"];
let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	uid = "u1";
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["x1"] });
	env = { DB: d1.DB, KEY_ENCRYPTION_KEY: "0000000000000000000000000000000000000000000000000000000000000000" } as unknown as Env;
	callRunner.mockReset();
});
afterEach(() => d1.close());

function app() {
	const a = new Hono<{ Bindings: Env }>();
	a.route("/v1/instances", secureInputRoutes);
	a.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	return a;
}
async function call(method: "GET" | "POST", path: string, body?: unknown) {
	const res = await app().request(`/v1/instances/i1${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
	// biome-ignore lint/suspicious/noExplicitAny: a JSON response read field by field in assertions.
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const create = (extra: Record<string, unknown> = {}) => call("POST", "/secure-inputs", { label: "Mac mini sudo password", destinationScope: "sudo", command: PMSET, ...extra });
const submit = (id: string, extra: Record<string, unknown> = {}) => call("POST", `/secure-inputs/${id}/submit`, { value: PASSWORD, ...extra });

describe("creating a sudo request", () => {
	it("takes the command as argv and shows it back, unapproved", async () => {
		const made = await create();
		expect(made.status).toBe(201);
		const status = await call("GET", `/secure-inputs/${made.body.id}`);
		expect(status.body).toMatchObject({ destinationScope: "sudo", status: "pending", command: PMSET, commandApproved: false });
	});

	it.each([
		["no command", { command: undefined }],
		["a command that is a string", { command: "pmset -a autorestart 1" }],
		["an empty command", { command: [] }],
		["sudo as the program", { command: ["sudo", "pmset"] }],
		["an option as the program", { command: ["-u", "root", "id"] }],
		["a newline in an argument", { command: ["pmset", "a\nb"] }],
	])("refuses %s", async (_name, extra) => {
		const made = await create(extra);
		expect(made.status).toBe(400);
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM secure_input_requests").get()).toEqual({ n: 0 });
	});

	it("a command belongs to a sudo request only: any other scope that names one is refused", async () => {
		for (const destinationScope of ["tmux", "env", "stdin", "file"]) expect((await create({ destinationScope })).status, destinationScope).toBe(400);
	});

	it("the other scopes are created exactly as before", async () => {
		const made = await call("POST", "/secure-inputs", { label: "Firebase code", destinationScope: "tmux", target: "main" });
		expect(made.status).toBe(201);
		expect((await call("GET", `/secure-inputs/${made.body.id}`)).body).toMatchObject({ destinationScope: "tmux", target: "main" });
	});
});

describe("the owner's submit is the approval", () => {
	it("a value without the approved command is refused, names the command it would run, and stores nothing", async () => {
		const made = await create();
		const res = await submit(made.body.id);
		expect(res.status).toBe(400);
		expect(res.body.error).toContain("sudo -- pmset -a autorestart 1");
		expect(res.body.error).toMatch(/approvedCommand/);
		expect(d1.sqlite.prepare("SELECT status, secret_ciphertext IS NOT NULL AS s FROM secure_input_requests WHERE id = ?").get(made.body.id)).toEqual({ status: "pending", s: 0 });
	});

	it("a value approved against a different command is refused too", async () => {
		const made = await create();
		for (const approvedCommand of [["pmset", "-a", "autorestart", "0"], [...PMSET, "x"], "pmset", null, [1, 2]]) {
			expect((await submit(made.body.id, { approvedCommand })).status, JSON.stringify(approvedCommand)).toBe(400);
		}
		expect((await call("GET", `/secure-inputs/${made.body.id}`)).body.status).toBe("pending");
	});

	it("approving exactly the command stores the value and answers the status — metadata only, never the value", async () => {
		const made = await create();
		const res = await submit(made.body.id, { approvedCommand: PMSET });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ status: "ready", command: PMSET, commandApproved: true, length: PASSWORD.length });
		expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
	});

	it("a request for any other scope is submitted as before, with no approval to give", async () => {
		const made = await call("POST", "/secure-inputs", { label: "code", destinationScope: "tmux" });
		expect((await submit(made.body.id)).status).toBe(200);
	});
});

describe("delivering", () => {
	async function ready() {
		const made = await create();
		await submit(made.body.id, { approvedCommand: PMSET });
		return made.body.id as string;
	}

	it("runs the approved command and reports the exit code; the body of the request carries nothing the caller could change", async () => {
		const id = await ready();
		callRunner.mockResolvedValue({ ok: true, exitCode: 0, stdout: "autorestart 1\n", stderr: "" });
		// A caller that tries to name its own command, target or value in the body is not listened to.
		const res = await call("POST", `/secure-inputs/${id}/sudo`, { command: ["rm", "-rf", "/"], value: "other", target: "main" });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ delivered: true, consumedValue: true, status: "consumed", exitCode: 0, command: PMSET, commandLine: "sudo -- pmset -a autorestart 1" });
		expect(callRunner).toHaveBeenCalledTimes(1);
		expect(callRunner.mock.calls[0][1]).toBe("/secure/sudo");
		expect(callRunner.mock.calls[0][2]).toMatchObject({ command: PMSET, value: PASSWORD });
		expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
	});

	it("a failed attempt answers 200 with delivered:false and leaves the request ready — it is an answer, not a server error", async () => {
		const id = await ready();
		callRunner.mockResolvedValue({ ok: false, exitCode: 1, stderr: "Sorry, try again.\nsudo: 1 incorrect password attempt" });
		const res = await call("POST", `/secure-inputs/${id}/sudo`, {});
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ delivered: false, consumedValue: false, status: "ready" });
		expect(res.body.reason).toContain("sudo: 1 incorrect password attempt");
		expect((await call("GET", `/secure-inputs/${id}`)).body.status).toBe("ready");
	});

	it("a request that does not exist, or is another account's, is a 404", async () => {
		const id = await ready();
		expect((await call("POST", "/secure-inputs/nope/sudo", {})).status).toBe(404);
		uid = "u2";
		expect((await call("POST", `/secure-inputs/${id}/sudo`, {})).status).toBe(404);
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("an unapproved or pending request is refused with the reason and the runner is never asked", async () => {
		const made = await create();
		const res = await call("POST", `/secure-inputs/${made.body.id}/sudo`, {});
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ delivered: false, status: "pending" });
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("the old terminal path refuses a sudo request instead of typing its password: it is not a tmux request", async () => {
		const id = await ready();
		const res = await call("POST", `/secure-inputs/${id}/inject`, { target: "main" });
		expect(res.body).toMatchObject({ delivered: false, consumedValue: false });
		expect(res.body.reason).toMatch(/inject delivers to a terminal only/);
		expect(callRunner).not.toHaveBeenCalled(); // nothing typed, nothing captured
	});
});
