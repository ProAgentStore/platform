import { describe, expect, it } from "vitest";
import { runApplyLoop, describeAction, type ApplyDecision, type ApplyDeps, type ApplyJob, type PageSnapshot } from "./apply-loop.js";
import { collectJobSecrets, isSecretFieldName, makeSecretRedactor, redactAction, redactEventData, SECRET_MASK } from "./redact-secrets.js";

/** The real thing's shape: `deriveJobPassword` returns "Pj9!" + 10 base64 chars. */
const PASSWORD = "Pj9!aB3xQ9mZk1";

describe("collectJobSecrets", () => {
	it("finds the ATS account password on an apply job", () => {
		expect(collectJobSecrets({ url: "https://x", password: PASSWORD })).toEqual([PASSWORD]);
	});

	it("finds a secret-named field NOBODY remembered to register", () => {
		// The point of reading the job's own keys: a field added later is covered by the
		// commit that adds it, not by someone remembering to update a list.
		expect(collectJobSecrets({ apiToken: "tok_abcdef123", sessionSecret: "s3cr3tvalue" }).sort()).toEqual(["s3cr3tvalue", "tok_abcdef123"]);
	});

	it("reads one level into providedAnswers, where an ask-and-hold answer lands", () => {
		expect(collectJobSecrets({ providedAnswers: { "Account password": "hunter2hunter2", "Preferred name": "Sam" } })).toEqual(["hunter2hunter2"]);
	});

	it("ignores non-secret fields and values too short to substitute safely", () => {
		expect(collectJobSecrets({ candidate: { email: "a@b.com", fullName: "Sam Smith" }, url: "https://x", password: "abc" })).toEqual([]);
	});
});

describe("isSecretFieldName", () => {
	it.each(["Password", "Confirm Password", "PIN", "Passcode", "SSN", "Tax File Number", "CVV", "Security answer", "Verification code"])("treats %s as secret", (name) => {
		expect(isSecretFieldName(name, "textbox")).toBe(true);
	});

	it.each(["Email", "Phone", "First name", "Pinterest profile", "Salary expectation"])("leaves %s alone", (name) => {
		expect(isSecretFieldName(name, "textbox")).toBe(false);
	});

	it("is false for an unnamed control — which is why value-based redaction exists", () => {
		expect(isSecretFieldName("", "textbox")).toBe(false);
	});
});

describe("makeSecretRedactor", () => {
	it("substitutes the secret wherever it appears in prose", () => {
		const redact = makeSecretRedactor([PASSWORD]);
		expect(redact(`type "${PASSWORD}" into textbox ""`)).toBe(`type "${SECRET_MASK}" into textbox ""`);
	});

	it("matches case-insensitively, so an ATS echoing it back upper-cased does not slip through", () => {
		expect(makeSecretRedactor([PASSWORD])(`field now reads ${PASSWORD.toUpperCase()}`)).toBe(`field now reads ${SECRET_MASK}`);
	});

	it("masks a longer secret whole rather than leaving its tail behind", () => {
		const redact = makeSecretRedactor(["abcdef", "abcdef123456"]);
		expect(redact("value abcdef123456 here")).toBe(`value ${SECRET_MASK} here`);
	});

	it("is the identity when there is nothing to redact", () => {
		expect(makeSecretRedactor([])("type \"Sam\" into textbox \"First name\"")).toBe("type \"Sam\" into textbox \"First name\"");
	});
});

describe("redactAction", () => {
	it("elides the typed value for a secret-named control", () => {
		expect(redactAction({ action: "type", name: "Password", text: "whatever" }).text).toBe(SECRET_MASK);
	});

	it("leaves an ordinary field's value alone — the trail stays debuggable", () => {
		expect(redactAction({ action: "type", name: "First name", text: "Sam" }).text).toBe("Sam");
	});
});

describe("redactEventData", () => {
	it("reaches a nested action, a model thought, and an ARIA snapshot alike", () => {
		const redact = makeSecretRedactor([PASSWORD]);
		const out = redactEventData(
			{
				thought: `I will now type ${PASSWORD} into the field`,
				action: { action: "type", ref: "f8e193", role: "textbox", name: "", text: PASSWORD },
				stuckSnapshot: `textbox "Password" value=${PASSWORD}`,
				recentActions: [`type "${PASSWORD}" into textbox ""`],
			},
			redact,
		) as Record<string, unknown>;
		expect(JSON.stringify(out)).not.toContain(PASSWORD);
		expect((out.action as { ref: string }).ref).toBe("f8e193"); // still diagnosable
	});

	it("stops at a bounded depth rather than walking a model-supplied graph forever", () => {
		let deep: unknown = "leaf";
		for (let i = 0; i < 40; i++) deep = { next: deep };
		expect(() => redactEventData(deep, makeSecretRedactor([PASSWORD]))).not.toThrow();
	});
});

describe("describeAction", () => {
	it("masks what is typed into a password field", () => {
		expect(describeAction({ action: "type", role: "textbox", name: "Password", text: PASSWORD })).toBe(`type "${SECRET_MASK}" into textbox "Password"`);
	});

	it("still shows an ordinary value, so the action trail keeps its purpose", () => {
		expect(describeAction({ action: "type", role: "textbox", name: "Email", text: "sam@example.com" })).toBe('type "sam@example.com" into textbox "Email"');
	});
});

/**
 * The regression test for #631 itself.
 *
 * Production held 18 `instance_task_events` containing the account password verbatim. The
 * decisive case is the one a field-name rule cannot catch and which produced 9 of those 18:
 * the brain types the password into a control whose accessible name is the EMPTY STRING.
 *
 * This drives the real `runApplyLoop` with that exact decision and asserts the password
 * reaches neither sink the loop owns — every event (message AND context, which is what
 * `agent_events.context` and the runner mirror are built from) and the transcript (which
 * becomes `ats_apply_cache.notes`, rendered back to the owner in the console).
 *
 * Before the fix both assertions fail.
 */
describe("#631 — a job secret never leaves the apply loop", () => {
	it("keeps the password out of every event and out of the transcript, even for an UNNAMED field", async () => {
		const events: Array<{ type: string; message: string; data?: unknown }> = [];
		const job = { url: "https://career10.successfactors.com/career", resumePath: "/cv.pdf", candidate: { fullName: "Sam", email: "sam@example.com" }, password: PASSWORD } as ApplyJob;
		let step = 0;
		const deps: ApplyDeps = {
			snapshot: async (): Promise<PageSnapshot> => ({ url: job.url, title: "Sign in", snapshot: `textbox ""`, challenge: null }),
			// The runner's write-back feedback echoes the field's REAL post-write value — a
			// second door the original issue named and the reason `logAction` redacts too.
			act: async () => ({ url: job.url, challenge: null, feedback: `field now reads ${PASSWORD}` }),
			decide: async (): Promise<ApplyDecision> => {
				step += 1;
				if (step === 1) return { thought: `Typing ${PASSWORD} into the password box`, action: { action: "type", ref: "f8e193", role: "textbox", name: "", text: PASSWORD } };
				return { finish: { status: "ready", detail: "done" } };
			},
			onEvent: (type, message, data) => {
				events.push({ type, message, data });
			},
		};

		const result = await runApplyLoop(deps, job, { maxSteps: 5 });

		expect(events.length).toBeGreaterThan(0);
		expect(JSON.stringify(events)).not.toContain(PASSWORD);
		expect((result.transcript ?? []).join("\n")).not.toContain(PASSWORD);
		// And the redaction is real, not an empty log: the step is still recorded.
		expect((result.transcript ?? []).join("\n")).toContain(SECRET_MASK);
	});
});
