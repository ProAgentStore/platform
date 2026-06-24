import { describe, expect, it } from "vitest";
import { createCredential, credDomain, deleteCredential, findCredentialForHost, listCredentials, revealCredential, updateCredential } from "./credentials.js";
import type { Env } from "../types.js";

// 32-byte (64 hex) master key for AES-KW envelope encryption in tests.
const KEK = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/** Minimal in-memory D1 that understands the queries credentials.ts issues. */
function mockEnv(): Env {
	const rows: Record<string, unknown>[] = [];
	const cols = ["id", "instance_id", "user_id", "domain", "login_url", "username", "secrets_ciphertext", "secrets_dek", "secrets_iv", "comments", "recovery_history"];
	const prepare = (sql: string) => ({
		bind: (...a: unknown[]) => ({
			all: async () => {
				if (/WHERE instance_id = \?1 AND user_id = \?2/.test(sql)) {
					return { results: rows.filter((r) => r.instance_id === a[0] && r.user_id === a[1]) };
				}
				return { results: [] };
			},
			first: async () => rows.find((r) => r.id === a[0] && r.instance_id === a[1] && r.user_id === a[2]) ?? null,
			run: async () => {
				if (sql.startsWith("INSERT")) {
					const row: Record<string, unknown> = { created_at: "t0", updated_at: "t0", last_used_at: null };
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
	return { DB: { prepare }, KEY_ENCRYPTION_KEY: KEK } as unknown as Env;
}

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
