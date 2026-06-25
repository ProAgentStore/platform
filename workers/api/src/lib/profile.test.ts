import { describe, expect, it } from "vitest";
import { getProfile, profileToCandidate, setProfileField, upsertProfile } from "./profile.js";
import type { Env } from "../types.js";

/** In-memory D1 mock for the single-row-per-user user_profile upsert. */
function mockEnv(): Env {
	const rows = new Map<string, Record<string, unknown>>();
	const cols = ["user_id", "first_name", "last_name", "email", "phone", "city", "state", "country", "postal_code", "linkedin", "website", "work_authorization", "salary_expectation", "custom"];
	const prepare = (sql: string) => ({
		bind: (...a: unknown[]) => ({
			first: async () => rows.get(String(a[0])) ?? null,
			run: async () => {
				if (sql.startsWith("INSERT INTO user_profile")) {
					const row: Record<string, unknown> = {};
					cols.forEach((c, i) => { row[c] = a[i] ?? null; });
					rows.set(String(a[0]), row);
				}
				return { meta: { changes: 1 } };
			},
		}),
	});
	return { DB: { prepare } } as unknown as Env;
}

describe("user profile", () => {
	it("upsert → get round-trips known fields + custom", async () => {
		const env = mockEnv();
		await upsertProfile(env, "u1", { firstName: "Sergey", lastName: "Ivochkin", email: "serge.pro.job@gmail.com", phone: "+61404453580", gitHubHandle: "serge-ivo" });
		const p = await getProfile(env, "u1");
		expect(p.firstName).toBe("Sergey");
		expect(p.email).toBe("serge.pro.job@gmail.com");
		expect(p.phone).toBe("+61404453580");
		expect(p.gitHubHandle).toBe("serge-ivo"); // custom field
	});

	it("setProfileField merges without clobbering other fields", async () => {
		const env = mockEnv();
		await upsertProfile(env, "u1", { firstName: "Sergey", email: "x@y.com" });
		await setProfileField(env, "u1", "salaryExpectation", "120000");
		const p = await getProfile(env, "u1");
		expect(p.firstName).toBe("Sergey"); // preserved
		expect(p.email).toBe("x@y.com"); // preserved
		expect(p.salaryExpectation).toBe("120000"); // added
	});

	it("empty string clears a field", async () => {
		const env = mockEnv();
		await upsertProfile(env, "u1", { phone: "123" });
		expect((await getProfile(env, "u1")).phone).toBe("123");
		await upsertProfile(env, "u1", { phone: "" });
		expect((await getProfile(env, "u1")).phone).toBeUndefined();
	});

	it("profileToCandidate derives fullName + location", () => {
		const c = profileToCandidate({ firstName: "Sergey", lastName: "Ivochkin", email: "x@y.com", city: "Melbourne", state: "VIC", country: "Australia", phone: "123" });
		expect(c.fullName).toBe("Sergey Ivochkin");
		expect(c.location).toBe("Melbourne, VIC, Australia");
		expect(c.email).toBe("x@y.com");
		expect(c.phone).toBe("123");
	});
});
