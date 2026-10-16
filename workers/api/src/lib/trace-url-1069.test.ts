/**
 * #1069 — a page URL in a run's record keeps origin and path only: no query, no fragment, no
 * credentials. Every value below is SYNTHETIC; the parameter NAMES are the ones the issue found on a
 * real sign-in page (OAuth/PKCE `state`, `nonce`, `code_challenge`; `redirect_uri`, `client`,
 * `audience`; the session ids `JobseekerSessionId` and `da_cdt`).
 *
 * Covered: the fill contract's `browser.navigated` / `browser.blocked` / `submit.unconfirmed` events and
 * its submitted / unavailable URLs; the Scout contract's events (the same defect, audited); and the
 * READ path over rows recorded before the write path reduced them — reduced on read, never rewritten
 * or purged.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, type RealSchemaD1, seedTenant } from "./d1-sqlite.js";
import { parseLocalApplyEvent, parseLocalApplyResult } from "./local-apply/contract.js";
import { parseLocalBrowserEvent, traceUrl as scoutTraceUrl } from "./local-browser/contract.js";
import { getApplyRun } from "./local-apply/store.js";
import { listLocalBrowserEvents } from "./local-browser/store.js";
import { getOwnedApplication } from "./local-artifact/store.js";
import type { Env } from "../types.js";

const SECRETS = ["SYNTH-STATE-7f3a", "SYNTH-NONCE-91c2", "SYNTHchallengeQ1w2e3", "SYNTH-CLIENT", "SYNTH-AUDIENCE", "SYNTH-SESSION-55aa", "visid_SYNTH|sessid_SYNTH", "frag-SYNTH", "p4ss-SYNTH"];
/** A sign-in page as the issue saw it, with synthetic values — and a fragment for good measure. */
const SIGN_IN =
	"https://login.seek.com/login?state=SYNTH-STATE-7f3a&nonce=SYNTH-NONCE-91c2&code_challenge=SYNTHchallengeQ1w2e3&code_challenge_method=S256" +
	"&redirect_uri=https%3A%2F%2Fwww.seek.com.au%2Foauth%2Fcallback&client=SYNTH-CLIENT&audience=SYNTH-AUDIENCE&JobseekerSessionId=SYNTH-SESSION-55aa" +
	"&da_cdt=visid_SYNTH%7Csessid_SYNTH#frag-SYNTH";
/** Credentials in the authority — `origin` never carries them. */
const WITH_CREDENTIALS = "https://ada:p4ss-SYNTH@accounts.example.com/oauth2/authorize?code=SYNTH-STATE-7f3a";
const noSecret = (v: unknown) => {
	const s = JSON.stringify(v);
	for (const x of SECRETS) expect(s, `"${x}" survived`).not.toContain(x);
};
const AT = "2026-10-14T01:02:03.000Z";

describe("the rule: origin and path, nothing else (#1069)", () => {
	it("strips OAuth/PKCE and session parameters, the fragment and credentials; keeps origin and path", () => {
		expect(scoutTraceUrl(SIGN_IN)).toBe("https://login.seek.com/login");
		expect(scoutTraceUrl(WITH_CREDENTIALS)).toBe("https://accounts.example.com/oauth2/authorize");
	});
	it("a plain URL passes through unchanged; anything not http(s) is dropped", () => {
		expect(scoutTraceUrl("https://www.seek.com.au/job/12345")).toBe("https://www.seek.com.au/job/12345");
		expect(scoutTraceUrl("http://careers.example.com:8443/roles/eng")).toBe("http://careers.example.com:8443/roles/eng");
		expect(scoutTraceUrl("javascript:alert(1)")).toBe("");
		expect(scoutTraceUrl("not a url")).toBe("");
	});
});

describe("the fill trace (Application Runner) keeps origin and path for every URL it records", () => {
	it.each(["browser.navigated", "browser.blocked", "submit.unconfirmed"])("%s", (type) => {
		const e = parseLocalApplyEvent({ type, at: AT, url: SIGN_IN, domain: "login.seek.com" });
		expect(e?.url).toBe("https://login.seek.com/login");
		noSecret(e);
	});

	it("a confirmed submit's page and an unavailable posting's page are kept as origin and path too", () => {
		const base = { runId: "run-1", traceId: "run-1", engineAuth: "machine-login" };
		const submitted = parseLocalApplyResult({ ...base, outcome: "submitted", mode: "auto_submit", submitted: { url: `https://www.seek.com.au/application/success?token=SYNTH-SESSION-55aa#frag-SYNTH`, at: AT, gateId: "g1" } });
		expect("result" in submitted && submitted.result.submitted?.url).toBe("https://www.seek.com.au/application/success");
		const unavailable = parseLocalApplyResult({ ...base, outcome: "blocked", mode: "fill_and_review", blockReason: "job_unavailable", unavailable: { reason: "expired", url: `https://www.seek.com.au/job/1?JobseekerSessionId=SYNTH-SESSION-55aa`, observedAt: AT, source: "page_notice" } });
		expect("result" in unavailable && unavailable.result.unavailable?.url).toBe("https://www.seek.com.au/job/1");
		noSecret([submitted, unavailable]);
	});
});

describe("the Scout trace (local browser) — the same defect, audited and fixed", () => {
	it.each(["browser.navigated", "browser.blocked", "finding.parsed"])("%s", (type) => {
		const e = parseLocalBrowserEvent({ type, at: AT, url: SIGN_IN, domain: "login.seek.com" });
		expect(e?.url).toBe("https://login.seek.com/login");
		noSecret(e);
	});
});

describe("rows recorded before the fix are reduced on READ — never rewritten, never purged", () => {
	let d1: RealSchemaD1;
	let env: Env;
	beforeEach(() => {
		d1 = realSchemaD1();
		seedTenant(d1, { userId: "u1", instanceIds: ["ap", "scout", "t1"] });
		env = { DB: d1.DB } as unknown as Env;
	});
	afterEach(() => d1.close());

	it("a fill run's trace, pause and result", async () => {
		const trace = [
			{ type: "browser.navigated", at: AT, url: SIGN_IN },
			{ type: "submit.unconfirmed", at: AT, url: WITH_CREDENTIALS },
			{ type: "engine.started", at: AT },
		];
		const result = { outcome: "submitted", submitted: { url: SIGN_IN, at: AT, gateId: "g1" } };
		d1.DB.prepare(
			`INSERT INTO local_apply_runs (id, instance_id, user_id, application_id, request_id, status, policy, trace, pause, result, created_at, updated_at)
			 VALUES ('run-old', 'ap', 'u1', 'app-1', 'req-1', 'paused', '{}', ?1, ?2, ?3, 1, 1)`,
		)
			.bind(JSON.stringify(trace), JSON.stringify({ reason: "login_required", url: SIGN_IN }), JSON.stringify(result))
			.run();
		const run = await getApplyRun(env, "ap", "u1", "run-old");
		expect(run?.trace.map((e) => (e as { url?: string }).url)).toEqual(["https://login.seek.com/login", "https://accounts.example.com/oauth2/authorize", undefined]);
		expect(run?.pause?.url).toBe("https://login.seek.com/login");
		expect((run?.result as { submitted: { url: string } }).submitted.url).toBe("https://login.seek.com/login");
		noSecret(run);
		// The stored row is untouched: this is a read projection, not a purge.
		expect((d1.sqlite.prepare("SELECT trace FROM local_apply_runs WHERE id = 'run-old'").get() as { trace: string }).trace).toContain("SYNTH-STATE-7f3a");
	});

	it("a Scout run's events", async () => {
		d1.exec(`INSERT INTO local_browser_runs (id, instance_id, user_id, request_id, objective, status, policy, created_at, updated_at) VALUES ('sr-1', 'scout', 'u1', 'req', 'roles', 'running', '{}', 1, 1)`);
		d1.DB.prepare(`INSERT INTO local_browser_run_events (run_id, seq, instance_id, user_id, type, url, at, recorded_at) VALUES ('sr-1', 1, 'scout', 'u1', 'browser.navigated', ?1, ?2, 1)`)
			.bind(SIGN_IN, AT)
			.run();
		const [e] = await listLocalBrowserEvents(env, "scout", "u1", "sr-1", 0, 10);
		expect(e.url).toBe("https://login.seek.com/login");
		noSecret(e);
	});

	it("an application's submitted page and its archive evidence", async () => {
		d1.DB.prepare(
			`INSERT INTO job_applications (id, instance_id, user_id, source_instance_id, lead_id, lifecycle_version, idempotency_key, status, lead, submitted_url, archive_evidence, created_at, updated_at)
			 VALUES ('app-1', 't1', 'u1', 'scout', 'lead-1', 1, 'k1', 'archived', '{}', ?1, ?2, 1, 1)`,
		)
			.bind(SIGN_IN, JSON.stringify({ reason: "expired", url: WITH_CREDENTIALS, observedAt: AT, source: "page_notice" }))
			.run();
		const app = await getOwnedApplication(env, "u1", "app-1");
		expect(app?.submittedUrl).toBe("https://login.seek.com/login");
		expect(app?.archiveEvidence).toEqual({ reason: "expired", url: "https://accounts.example.com/oauth2/authorize", observedAt: AT, source: "page_notice" });
		noSecret(app);
	});
});
