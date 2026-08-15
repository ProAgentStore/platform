import { describe, expect, it } from "vitest";
import { createCredential, credDomain, credentialMatchRank, deleteCredential, findCredentialForHost, listCredentials, revealCredential, updateCredential } from "./credentials.js";
import type { Env } from "../types.js";

// 32-byte (64 hex) master key for AES-KW envelope encryption in tests.
const KEK = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/** Minimal in-memory D1 that understands the queries credentials.ts issues. */
/** `null` = this deployment has no encryption key (#220). Not `undefined`: a default
 *  parameter treats an explicitly-passed undefined as absent and would hand back the key. */
function mockEnv(kek: string | null = KEK): Env {
	const rows: Record<string, unknown>[] = [];
	const logged: string[] = [];
	let seq = 0;
	const cols = ["id", "instance_id", "user_id", "domain", "login_url", "username", "secrets_ciphertext", "secrets_dek", "secrets_iv", "comments", "recovery_history"];
	const prepare = (sql: string) => ({
		bind: (...a: unknown[]) => ({
			all: async () => {
				if (/WHERE instance_id = \?1 AND user_id = \?2/.test(sql)) {
					const hits = rows.filter((r) => r.instance_id === a[0] && r.user_id === a[1]);
					// Honour the ORDER BY the real query carries (#650) — without it the mock hands
					// back insertion order and a test for the newest-first tie-break would pass by
					// accident, measuring the fixture instead of the code.
					if (/ORDER BY created_at DESC/.test(sql)) hits.sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)) || String(x.id).localeCompare(String(y.id)));
					return { results: hits };
				}
				return { results: [] };
			},
			first: async () => rows.find((r) => r.id === a[0] && r.instance_id === a[1] && r.user_id === a[2]) ?? null,
			run: async () => {
				// Checked BEFORE the generic INSERT arm: `logEvent` writes agent_events through this
				// same mock, and the arm below would file a trace row as a credential.
				if (/INSERT INTO agent_events/.test(sql)) {
					logged.push(JSON.stringify(a));
					return { meta: { changes: 1 } };
				}
				if (sql.startsWith("INSERT")) {
					// Distinct, increasing created_at per insert — insertion order IS storage order in
					// the real table, and the newest-first tie-break is only testable if they differ.
					const row: Record<string, unknown> = { created_at: `t${String(seq++).padStart(3, "0")}`, updated_at: "t0", last_used_at: null };
					cols.forEach((c, i) => { row[c] = a[i] ?? null; });
					rows.push(row);
					return { meta: { changes: 1 } };
				}
				if (sql.startsWith("DELETE")) {
					const i = rows.findIndex((r) => r.id === a[0] && r.instance_id === a[1] && r.user_id === a[2]);
					if (i >= 0) { rows.splice(i, 1); return { meta: { changes: 1 } }; }
					return { meta: { changes: 0 } };
				}
				if (/SET last_used_at/.test(sql)) {
					const r = rows.find((x) => x.id === a[0]); if (r) r.last_used_at = "t1"; return { meta: { changes: 1 } };
				}
				if (sql.startsWith("UPDATE")) {
					// updateCredential: domain=?1..user_id=?11 (id=?9, instance=?10, user=?11)
					const r = rows.find((x) => x.id === a[8] && x.instance_id === a[9] && x.user_id === a[10]);
					if (r) { r.domain = a[0]; r.login_url = a[1]; r.username = a[2]; r.secrets_ciphertext = a[3]; r.secrets_dek = a[4]; r.secrets_iv = a[5]; r.comments = a[6]; r.recovery_history = a[7]; return { meta: { changes: 1 } }; }
					return { meta: { changes: 0 } };
				}
				return { meta: { changes: 0 } };
			},
		}),
	});
	return { DB: { prepare }, KEY_ENCRYPTION_KEY: kek ?? undefined, __events: logged } as unknown as Env;
}

/** The trace rows `logEvent` wrote through the mock DB — bind args, stringified. */
const events = (env: Env): string[] => (env as unknown as { __events: string[] }).__events;

describe("credDomain", () => {
	it("normalizes URLs and hosts to a bare host", () => {
		expect(credDomain("https://jobs.dayforcehcm.com/en-AU/x/jobs/1")).toBe("jobs.dayforcehcm.com");
		expect(credDomain("www.Lever.co")).toBe("lever.co");
	});
});

describe("credentials vault", () => {
	it("encrypts secrets at rest, reveals them back, and never lists plaintext", async () => {
		const env = mockEnv();
		const id = await createCredential(env, "inst-1", "u1", { domain: "dayforcehcm.com", loginUrl: "https://dfid.dayforcehcm.com/login", username: "serge.pro.job@gmail.com", password: "S3cr3t!Pass", pin: "4821", comments: "Red Cross ATS" });

		// List exposes flags, never the secret values.
		const list = await listCredentials(env, "inst-1", "u1");
		expect(list).toHaveLength(1);
		expect(list[0].hasPassword).toBe(true);
		expect(list[0].hasPin).toBe(true);
		expect(JSON.stringify(list[0])).not.toContain("S3cr3t!Pass");
		expect(list[0].username).toBe("serge.pro.job@gmail.com");

		// Reveal decrypts the real secrets.
		const revealed = await revealCredential(env, "inst-1", "u1", id);
		expect(revealed?.password).toBe("S3cr3t!Pass");
		expect(revealed?.pin).toBe("4821");
	});

	it("the agent finds a credential by host suffix and gets the decrypted password", async () => {
		const env = mockEnv();
		await createCredential(env, "inst-1", "u1", { domain: "dayforcehcm.com", username: "me@x.com", password: "RealPw99!" });
		// A job on jobs.dayforcehcm.com matches the stored dayforcehcm.com.
		const found = await findCredentialForHost(env, "inst-1", "u1", "https://jobs.dayforcehcm.com/en-AU/x");
		expect(found?.password).toBe("RealPw99!");
		expect(found?.username).toBe("me@x.com");
		// No credential for an unrelated host.
		expect(await findCredentialForHost(env, "inst-1", "u1", "lever.co")).toBeNull();
	});

	it("update keeps the existing password unless a new one is supplied", async () => {
		const env = mockEnv();
		const id = await createCredential(env, "inst-1", "u1", { domain: "x.com", password: "old", pin: "1111" });
		await updateCredential(env, "inst-1", "u1", id, { domain: "x.com", comments: "note only" });
		const r = await revealCredential(env, "inst-1", "u1", id);
		expect(r?.password).toBe("old"); // unchanged
		expect(r?.comments).toBe("note only");
		await updateCredential(env, "inst-1", "u1", id, { domain: "x.com", password: "new" });
		expect((await revealCredential(env, "inst-1", "u1", id))?.password).toBe("new");
	});

	it("delete removes the credential", async () => {
		const env = mockEnv();
		const id = await createCredential(env, "inst-1", "u1", { domain: "x.com", password: "p" });
		expect(await deleteCredential(env, "inst-1", "u1", id)).toBe(true);
		expect(await listCredentials(env, "inst-1", "u1")).toHaveLength(0);
	});
});

// ── #220: a secret write must never silently succeed without encryption ──────
//
// encryptSecretsFor returned null both for "this credential has no secrets" and for "there is
// no KEY_ENCRYPTION_KEY", and callers wrote `enc?.c ?? null` either way. So a misconfigured
// deployment accepted an ATS password with a 200 and stored nothing — and on UPDATE wrote NULL
// over ciphertext that was already there, destroying a working credential.
describe("credential vault fails closed without a key (#220)", () => {
	it("refuses to create a credential carrying secrets", async () => {
		const env = mockEnv(null);
		await expect(
			createCredential(env, "i1", "u1", { domain: "acme.com", password: "hunter2" }),
		).rejects.toThrow(/encryption key/i);
	});

	it("still allows a metadata-only credential — nothing secret is at risk", async () => {
		const env = mockEnv(null);
		const id = await createCredential(env, "i1", "u1", { domain: "acme.com", username: "me@acme.com" });
		expect(id).toBeTruthy();
		const list = await listCredentials(env, "i1", "u1");
		expect(list.map((c) => c.username)).toContain("me@acme.com");
	});

	it("refuses to update a credential that HAS stored secrets, leaving the ciphertext intact", async () => {
		// Store it properly first, with a working key.
		const good = mockEnv();
		const id = await createCredential(good, "i1", "u1", { domain: "acme.com", password: "hunter2" });
		const before = await revealCredential(good, "i1", "u1", id);
		expect(before?.password).toBe("hunter2");

		// Now the key disappears (rotation gone wrong, missing secret binding, …).
		const broken = { ...(good as unknown as Record<string, unknown>), KEY_ENCRYPTION_KEY: undefined } as unknown as Env;
		await expect(
			updateCredential(broken, "i1", "u1", id, { domain: "acme.com", username: "renamed" }),
		).rejects.toThrow(/encryption key/i);

		// The stored secret survived: refusing beats writing NULL over recoverable ciphertext,
		// because the key can come back and the password cannot.
		const after = await revealCredential(good, "i1", "u1", id);
		expect(after?.password).toBe("hunter2");
	});
});

// ── #325: the #220 guard was narrower than the hazard it documents ───────────
//
// That guard fires on a MISSING key. A key that is present but WRONG — a rotation gone wrong, a
// re-derived KEK, a damaged DEK/IV — failed inside `decryptSecrets`, which returned `{}` for both
// "no secrets stored" and "could not decrypt". So the merge in `updateCredential` saw "there was
// nothing here", `encryptSecretsFor` had nothing to encrypt, and the UPDATE wrote NULL over intact
// ciphertext — while returning true, so the API answered 200 "saved" to a request that destroyed
// the user's ATS password. Storing ciphertext we cannot read is strictly better: a key can come back.
describe("credential vault fails closed on an UNREADABLE secret (#325)", () => {
	const WRONG_KEK = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

	/** Same rows, different key — what a rotated/re-derived KEK looks like to this module. */
	const withKek = (env: Env, kek: string) => ({ ...(env as unknown as Record<string, unknown>), KEY_ENCRYPTION_KEY: kek }) as unknown as Env;

	it("refuses the update and leaves the ciphertext recoverable", async () => {
		const good = mockEnv();
		const id = await createCredential(good, "i1", "u1", { domain: "acme.com", password: "hunter2" });

		await expect(
			updateCredential(withKek(good, WRONG_KEK), "i1", "u1", id, { domain: "acme.com", username: "renamed" }),
		).rejects.toThrow(/could not be decrypted/i);

		// The whole point: the right key still opens it.
		expect((await revealCredential(good, "i1", "u1", id))?.password).toBe("hunter2");
	});

	it("reports hasPassword TRUE for a row it cannot read, not 'no password stored'", async () => {
		// Reporting false invites the owner to 'fix' it with exactly the metadata edit above.
		const good = mockEnv();
		await createCredential(good, "i1", "u1", { domain: "acme.com", password: "hunter2" });
		const list = await listCredentials(withKek(good, WRONG_KEK), "i1", "u1");
		expect(list[0].hasPassword).toBe(true);
	});

	it("hands the apply agent NO credential, and does not stamp last_used_at", async () => {
		// `{password: undefined}` is what produced "hasStoredLogin: true but the login doesn't
		// work" — the brain tries it, fails, and burns the run on a stuck handoff. And last_used_at
		// is the column an owner reads to decide whether a credential is still in play.
		const good = mockEnv();
		await createCredential(good, "i1", "u1", { domain: "acme.com", password: "hunter2" });
		expect(await findCredentialForHost(withKek(good, WRONG_KEK), "i1", "u1", "jobs.acme.com")).toBeNull();
		expect((await listCredentials(good, "i1", "u1"))[0].lastUsedAt).toBeUndefined();
	});
});

describe("credentialMatchRank — which stored credential fits a host (#650)", () => {
	it("an exact host beats an ancestor, which beats a descendant", () => {
		expect(credentialMatchRank("jobs.dayforcehcm.com", "jobs.dayforcehcm.com")).toBe(0);
		const parent = credentialMatchRank("jobs.dayforcehcm.com", "dayforcehcm.com") as number;
		const child = credentialMatchRank("bigco.com", "careers.bigco.com") as number;
		expect(parent).toBeGreaterThan(0);
		expect(child).toBeGreaterThan(parent);
	});

	it("the closer of two ancestors wins — specificity, not just tier", () => {
		const near = credentialMatchRank("a.b.c.example.com", "c.example.com") as number;
		const far = credentialMatchRank("a.b.c.example.com", "example.com") as number;
		expect(near).toBeLessThan(far);
	});

	it("an unrelated host does not match, and a shared SUFFIX is not a relationship", () => {
		expect(credentialMatchRank("jobs.dayforcehcm.com", "lever.co")).toBeNull();
		// "notdayforcehcm.com" ends with "dayforcehcm.com" as a STRING but is a different domain.
		expect(credentialMatchRank("notdayforcehcm.com", "dayforcehcm.com")).toBeNull();
	});
});

describe("the apply agent signs in with the RIGHT credential, not the first-stored one (#650)", () => {
	it("prefers the exact host over the broader domain stored before it", async () => {
		// The issue's reproduction, in the order that produced it: the broad credential is stored
		// FIRST, so the unordered query yielded it and `.find()` took it. Before the fix this
		// returns the dayforcehcm.com account — the wrong username on a real application.
		const env = mockEnv();
		await createCredential(env, "i1", "u1", { domain: "dayforcehcm.com", username: "broad@example.com", password: "broad-pw" });
		await createCredential(env, "i1", "u1", { domain: "jobs.dayforcehcm.com", username: "exact@example.com", password: "exact-pw" });
		const found = await findCredentialForHost(env, "i1", "u1", "https://jobs.dayforcehcm.com/en-AU/careers/1");
		expect(found?.username).toBe("exact@example.com");
		expect(found?.password).toBe("exact-pw");
	});

	it("still falls back to the ancestor when nothing matches the host exactly", async () => {
		// The behaviour the vault is FOR — one ATS account covering its subdomains — must survive.
		const env = mockEnv();
		await createCredential(env, "i1", "u1", { domain: "dayforcehcm.com", username: "broad@example.com", password: "broad-pw" });
		expect((await findCredentialForHost(env, "i1", "u1", "https://jobs.dayforcehcm.com/x"))?.username).toBe("broad@example.com");
	});

	it("prefers an ancestor over a descendant of the requested host", async () => {
		const env = mockEnv();
		await createCredential(env, "i1", "u1", { domain: "careers.bigco.com", username: "sub@example.com", password: "sub-pw" });
		await createCredential(env, "i1", "u1", { domain: "com", username: "tld@example.com", password: "tld-pw" });
		// Requesting bigco.com: "com" is an ancestor, "careers.bigco.com" a descendant guess.
		expect((await findCredentialForHost(env, "i1", "u1", "bigco.com"))?.username).toBe("tld@example.com");
	});

	it("breaks a same-domain tie with the NEWEST credential — the replacement, not the stale one", async () => {
		// Two accounts on one host is the case the data model cannot express. The owner's most
		// recent act is the best available signal: when a password expires and they store a
		// replacement, the stale row is the one with the recent USE and the new one has none,
		// which is why the tie-break is created_at and not last_used_at.
		const env = mockEnv();
		await createCredential(env, "i1", "u1", { domain: "acme.com", username: "old@example.com", password: "old-pw" });
		await createCredential(env, "i1", "u1", { domain: "acme.com", username: "new@example.com", password: "new-pw" });
		expect((await findCredentialForHost(env, "i1", "u1", "acme.com"))?.username).toBe("new@example.com");
	});

	it("records which credential was chosen ONLY when the choice was ambiguous", async () => {
		// A determined-but-wrong answer is harder to notice than a random one, so the ambiguous
		// case leaves a trace; the ordinary one-credential case stays silent.
		const env = mockEnv();
		await createCredential(env, "i1", "u1", { domain: "acme.com", username: "only@example.com", password: "pw" });
		await findCredentialForHost(env, "i1", "u1", "acme.com");
		expect(events(env).filter((e) => e.includes("credential.selected"))).toEqual([]);

		await createCredential(env, "i1", "u1", { domain: "jobs.acme.com", username: "exact@example.com", password: "pw2" });
		await findCredentialForHost(env, "i1", "u1", "jobs.acme.com");
		expect(events(env).filter((e) => e.includes("credential.selected")).length).toBe(1);
	});
});
