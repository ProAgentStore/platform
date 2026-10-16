/**
 * #1106: a fill paused for a SEEK sign-in signs itself in with the code SEEK emails, read from the
 * Runner's pinned Gmail — and says so plainly when it cannot. Over the real schema; only the runner
 * (the relay to `pags up`) and the mailbox (Gmail's API) are faked.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../types.js";
import { type RealSchemaD1, realSchemaD1, seedTenant } from "../d1-sqlite.js";
import { CODE_WAIT_MS, type EmailSignInDeps, advanceEmailCodeSignIn, emailCodeWillTry, signInCodeIn } from "./email-code-sign-in.js";
import { type ApplyRun, getApplyRun } from "./store.js";

const UID = "u1";
const RUNNER = "runner-1";
const RUN = "run-1";
const JOB_MAILBOX = "serge.pro.job@gmail.com";
const OTHER_MAILBOX = "sivochkin@gmail.com";
const T0 = Date.parse("2026-10-16T08:00:00Z");
const SEEK_PAUSE = { reason: "login_required", domain: "au.seek.com", url: "https://au.seek.com/job/95289924", question: "Sign in to seek.com in this browser." };

let d1: RealSchemaD1;
let emailPermission: boolean;
const env = () => ({ DB: d1.DB, AGENT: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ permissions: { email: emailPermission } }) }) } }) as unknown as Env;

/** A fake runner that records every step it was sent, and a fake mailbox of SEEK mail. */
function fakes(opts: { request?: unknown; enter?: unknown; mail?: Array<{ id: string; date: string; subject: string; text: string }> } = {}) {
	const sent: Array<Record<string, unknown>> = [];
	const read: string[] = [];
	const mail = opts.mail ?? [];
	const deps: EmailSignInDeps = {
		runner: async (_path, body) => {
			const b = body as Record<string, unknown>;
			sent.push(b);
			const out = b.step === "request" ? ("request" in opts ? opts.request : { state: "code_requested" }) : ("enter" in opts ? opts.enter : { state: "signed_in" });
			return out === null ? null : { status: 200, body: out };
		},
		mailbox: async () => ({
			list: async () => mail.map(({ id, date }) => ({ id, date })),
			read: async (id) => {
				read.push(id);
				const m = mail.find((x) => x.id === id) as (typeof mail)[number];
				return { subject: m.subject, text: m.text };
			},
		}),
	};
	return { deps, sent, read };
}

const run = async (): Promise<ApplyRun> => (await getApplyRun(env(), RUNNER, UID, RUN)) as ApplyRun;
const row = () => d1.DB.prepare("SELECT * FROM local_apply_email_sign_ins WHERE run_id = ?1").bind(RUN).first<Record<string, unknown>>();
const settings = { signInEmail: JOB_MAILBOX };

beforeEach(() => {
	d1 = realSchemaD1();
	emailPermission = true;
	seedTenant(d1, { userId: UID, instanceIds: [RUNNER] });
	d1.exec(`UPDATE agent_instances SET config = '{"connectorAccounts":{"gmail":"${JOB_MAILBOX}"}}' WHERE id = '${RUNNER}'`);
	for (const account of [OTHER_MAILBOX, JOB_MAILBOX]) {
		d1.exec(`INSERT INTO user_api_keys (user_id, provider, account_id, account_label, key_ciphertext, dek_wrapped, iv, granted_scopes) VALUES ('${UID}', 'gmail', '${account}', '${account}', x'00', x'00', x'00', 'https://www.googleapis.com/auth/gmail.readonly')`);
	}
	d1.exec(
		`INSERT INTO local_apply_runs (id, instance_id, user_id, application_id, request_id, status, policy, pause, created_at, updated_at)
		 VALUES ('${RUN}', '${RUNNER}', '${UID}', 'app-1', 'req-1', 'paused', '{}', '${JSON.stringify(SEEK_PAUSE)}', ${T0}, ${T0})`,
	);
});
afterEach(() => d1.close());

const CODE_MAIL = { id: "msg-new", date: new Date(T0 + 40_000).toUTCString(), subject: "Your SEEK sign in code", text: "Hi Serge, your sign in code is 482913. It expires in 10 minutes. Job ID 95289924." };

describe("the email-code sign-in (#1106)", () => {
	it("requests a code for the SEEK-account email, reads it from the pinned mailbox, enters it — and never keeps the code", async () => {
		const stale = { id: "msg-old", date: new Date(T0 - 3_600_000).toUTCString(), subject: "Your SEEK sign in code", text: "Your sign in code is 111111." };
		const f = fakes({ mail: [CODE_MAIL, stale] });

		const first = await advanceEmailCodeSignIn(env(), UID, await run(), settings, T0, f.deps);
		expect(first.outcome).toBe("waiting");
		expect(f.sent).toEqual([{ runId: RUN, step: "request", email: JOB_MAILBOX }]);
		expect(await row()).toMatchObject({ state: "code_requested", mailbox: JOB_MAILBOX, requested_at: T0 });

		const second = await advanceEmailCodeSignIn(env(), UID, await run(), settings, T0 + 60_000, f.deps);
		expect(second.outcome).toBe("signed_in");
		expect(f.sent[1]).toEqual({ runId: RUN, step: "enter", code: "482913" });
		// The mail from before the request is an old code: never opened.
		expect(f.read).toEqual(["msg-new"]);
		expect(await row()).toMatchObject({ state: "signed_in", message_id: "msg-new" });

		// Auditable — which inbox, which message — and the code is nowhere.
		const trace = (await run()).trace;
		expect(trace.map((e) => e.detail?.decision)).toEqual(["code_requested", "code_read"]);
		expect(trace[1].detail).toMatchObject({ tool: "email_code_sign_in", mailbox: JOB_MAILBOX, messageId: "msg-new" });
		expect(JSON.stringify(trace) + JSON.stringify(await row())).not.toContain("482913");
	});

	it("an old code in the inbox — mail from before the request — is never entered", async () => {
		const stale = { id: "msg-old", date: new Date(T0 - 3_600_000).toUTCString(), subject: "Your SEEK sign in code", text: "Your sign in code is 111111." };
		const f = fakes({ mail: [stale] });
		await advanceEmailCodeSignIn(env(), UID, await run(), settings, T0, f.deps);
		expect((await advanceEmailCodeSignIn(env(), UID, await run(), settings, T0 + 60_000, f.deps)).outcome).toBe("waiting");
		expect(f.sent.filter((s) => s.step === "enter")).toEqual([]);
		expect(f.read).toEqual([]);
	});

	it("says so when the SEEK address is not the mailbox this Runner reads — and asks the runner for nothing", async () => {
		const f = fakes();
		const out = await advanceEmailCodeSignIn(env(), UID, await run(), { signInEmail: "serge.job.dev@gmail.com" }, T0, f.deps);
		expect(out.outcome).toBe("failed");
		expect(f.sent).toEqual([]);
		const reason = String((await run()).trace.at(-1)?.detail?.reason);
		expect(reason).toContain("serge.job.dev@gmail.com");
		expect(reason).toContain(JOB_MAILBOX);
		expect(await row()).toMatchObject({ state: "failed", failure: "mailbox_mismatch" });
	});

	it("fails closed when the owner has not turned email access on", async () => {
		emailPermission = false;
		const f = fakes();
		expect((await advanceEmailCodeSignIn(env(), UID, await run(), settings, T0, f.deps)).outcome).toBe("failed");
		expect(f.sent).toEqual([]);
		expect(await row()).toMatchObject({ failure: "email_not_permitted" });
	});

	it("a code that never arrives ends after the wait with a reason, once — not a hang, not a repeated alert", async () => {
		const f = fakes();
		await advanceEmailCodeSignIn(env(), UID, await run(), settings, T0, f.deps);
		expect((await advanceEmailCodeSignIn(env(), UID, await run(), settings, T0 + CODE_WAIT_MS - 1_000, f.deps)).outcome).toBe("waiting");
		expect((await advanceEmailCodeSignIn(env(), UID, await run(), settings, T0 + CODE_WAIT_MS + 1_000, f.deps)).outcome).toBe("failed");
		expect(String((await run()).trace.at(-1)?.detail?.reason)).toMatch(/No SEEK sign-in code reached serge\.pro\.job@gmail\.com/);
		// Settled: the next sync does nothing, so the owner is alerted exactly once.
		expect((await advanceEmailCodeSignIn(env(), UID, await run(), settings, T0 + CODE_WAIT_MS + 60_000, f.deps)).outcome).toBe("not_applicable");
	});

	it("a code SEEK refuses, or a runner too old to know the step, hands the sign-in to the owner", async () => {
		const rejected = fakes({ mail: [CODE_MAIL], enter: { state: "failed", reason: "code_rejected" } });
		await advanceEmailCodeSignIn(env(), UID, await run(), settings, T0, rejected.deps);
		expect((await advanceEmailCodeSignIn(env(), UID, await run(), settings, T0 + 60_000, rejected.deps)).outcome).toBe("failed");
		expect(await row()).toMatchObject({ state: "failed", failure: "code_rejected" });

		d1.exec(`DELETE FROM local_apply_email_sign_ins`);
		const old = fakes({ request: null });
		expect((await advanceEmailCodeSignIn(env(), UID, await run(), settings, T0, old.deps)).outcome).toBe("failed");
		expect(await row()).toMatchObject({ failure: "runner_unavailable" });
	});

	it("two syncs racing ask SEEK for ONE code", async () => {
		const f = fakes();
		const [a, b] = await Promise.all([advanceEmailCodeSignIn(env(), UID, await run(), settings, T0, f.deps), advanceEmailCodeSignIn(env(), UID, await run(), settings, T0, f.deps)]);
		expect([a.outcome, b.outcome]).toEqual(["waiting", "waiting"]);
		expect(f.sent.filter((s) => s.step === "request")).toHaveLength(1);
	});

	it("only a SEEK sign-in pause, and only once the owner named the SEEK address", async () => {
		const f = fakes();
		expect((await advanceEmailCodeSignIn(env(), UID, await run(), { signInEmail: null }, T0, f.deps)).outcome).toBe("not_applicable");
		d1.exec(`UPDATE local_apply_runs SET pause = '${JSON.stringify({ ...SEEK_PAUSE, domain: "boards.greenhouse.io" })}'`);
		expect((await advanceEmailCodeSignIn(env(), UID, await run(), settings, T0, f.deps)).outcome).toBe("not_applicable");
		expect(f.sent).toEqual([]);
	});

	it("the owner is not alerted while it will be tried, and is once this run has tried", async () => {
		expect(await emailCodeWillTry(env(), await run(), settings)).toBe(true);
		expect(await emailCodeWillTry(env(), await run(), { signInEmail: null })).toBe(false);
		await advanceEmailCodeSignIn(env(), UID, await run(), settings, T0, fakes().deps);
		expect(await emailCodeWillTry(env(), await run(), settings)).toBe(false);
	});
});

describe("signInCodeIn", () => {
	it("reads a code named as one, either way round", () => {
		expect(signInCodeIn("Your SEEK sign in code", "Your sign in code is 482913.")).toBe("482913");
		expect(signInCodeIn("482913 is your SEEK sign in code", "")).toBe("482913");
	});
	it("never takes a job id or a salary for a code", () => {
		expect(signInCodeIn("20 new jobs for Software Developer", "Job 95289924 pays $120000")).toBeNull();
	});
});
