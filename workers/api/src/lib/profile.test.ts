import { describe, expect, it } from "vitest";
import { getProfile, guessProfileKey, profileCustomAnswers, profileToCandidate, saveAskAndHoldAnswer, setProfileField, upsertProfile } from "./profile.js";
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

	it("saveAskAndHoldAnswer fills an EMPTY standard field directly", async () => {
		const env = mockEnv();
		await upsertProfile(env, "u1", { firstName: "Sergey" });
		await saveAskAndHoldAnswer(env, "u1", "Phone number", "+61404453580");
		expect((await getProfile(env, "u1")).phone).toBe("+61404453580"); // mapped to the standard key
	});

	it("saveAskAndHoldAnswer does NOT clobber a POPULATED standard field — routes to custom instead", async () => {
		const env = mockEnv();
		await upsertProfile(env, "u1", { email: "canonical@me.com" });
		// A per-application "email" answer must not overwrite the canonical Profile email.
		await saveAskAndHoldAnswer(env, "u1", "Contact email for this role", "role-specific@corp.com");
		const p = await getProfile(env, "u1");
		expect(p.email).toBe("canonical@me.com"); // canonical PII preserved
		// still reusable as a providedAnswer next time (stashed under a custom key)
		expect(Object.values(profileCustomAnswers(p))).toContain("role-specific@corp.com");
	});

	it("profileCustomAnswers reuses stable eligibility facts but NOT job-specific free-text", async () => {
		const env = mockEnv();
		// A reusable eligibility fact (short, factual) → surfaced for next time.
		await saveAskAndHoldAnswer(env, "u1", "Australian working rights", "Australian citizen");
		await saveAskAndHoldAnswer(env, "u1", "Notice period", "4 weeks");
		// Company-specific free-text answers → must NOT bleed onto a DIFFERENT company's form.
		await saveAskAndHoldAnswer(env, "u1", "Why do you want to work here?", "Because Acme's mission to reinvent widgets excites me.");
		await saveAskAndHoldAnswer(env, "u1", "Cover letter", "Dear Acme, I am thrilled to apply…");
		// A very long answer is an essay, not a fact — excluded even without a giveaway label.
		await saveAskAndHoldAnswer(env, "u1", "Anything else", "x".repeat(250));
		const answers = profileCustomAnswers(await getProfile(env, "u1"));
		const vals = Object.values(answers);
		expect(vals).toContain("Australian citizen");
		expect(vals).toContain("4 weeks");
		expect(vals).not.toContain("Because Acme's mission to reinvent widgets excites me.");
		expect(vals.some((v) => v.startsWith("Dear Acme"))).toBe(false);
		expect(vals.some((v) => v.length > 200)).toBe(false);
	});

	it("profileToCandidate derives fullName + location", () => {
		const c = profileToCandidate({ firstName: "Sergey", lastName: "Ivochkin", email: "x@y.com", city: "Melbourne", state: "VIC", country: "Australia", phone: "123" });
		expect(c.fullName).toBe("Sergey Ivochkin");
		expect(c.location).toBe("Melbourne, VIC, Australia");
		expect(c.email).toBe("x@y.com");
		expect(c.phone).toBe("123");
	});
});

describe("guessProfileKey — a substring match writes the WRONG canonical PII", () => {
	// `saveAskAndHoldAnswer` writes the answer straight into the matched standard column whenever
	// that column is EMPTY — which is exactly when the agent is asking. So an unrelated word in a
	// free-text question silently overwrote canonical PII, and `profileToCandidate` then emitted it
	// into the apply prompt, where the brain typed it into a live job application.
	it("does not read a phone number out of 'hotel'", () => {
		expect(guessProfileKey("Have you worked in hotel management?")).not.toBe("phone");
	});

	it("does not read a salary out of 'accurate' or 'corporate'", () => {
		expect(guessProfileKey("Is this statement accurate?")).not.toBe("salaryExpectation");
		expect(guessProfileKey("How many years at a corporate law firm?")).not.toBe("salaryExpectation");
	});

	it("does not read a website out of 'onsite'", () => {
		expect(guessProfileKey("Are you an onsite or remote candidate?")).not.toBe("website");
	});

	it("does not read a city out of 'capacity', or a state out of 'statement'", () => {
		expect(guessProfileKey("What is your capacity to travel?")).not.toBe("city");
		expect(guessProfileKey("Do you agree with the statement?")).not.toBe("state");
	});

	it("still maps the real labels it exists for", () => {
		expect(guessProfileKey("Phone number")).toBe("phone");
		expect(guessProfileKey("Mobile")).toBe("phone");
		expect(guessProfileKey("Salary expectation")).toBe("salaryExpectation");
		expect(guessProfileKey("Hourly rate")).toBe("salaryExpectation");
		expect(guessProfileKey("LinkedIn URL")).toBe("linkedin");
		expect(guessProfileKey("Portfolio website")).toBe("website");
		expect(guessProfileKey("Are you authorized to work in the US?")).toBe("workAuthorization");
		expect(guessProfileKey("City")).toBe("city");
		expect(guessProfileKey("State/Province")).toBe("state");
		expect(guessProfileKey("Country")).toBe("country");
		expect(guessProfileKey("Email address")).toBe("email");
		expect(guessProfileKey("First name")).toBe("firstName");
		expect(guessProfileKey("Last name")).toBe("lastName");
		expect(guessProfileKey("Postal code")).toBe("postalCode");
	});

	it("falls back to a sanitized custom key for a genuinely non-standard question", () => {
		expect(guessProfileKey("How did you hear about us?")).toBe("how_did_you_hear_about_us");
	});
});
