import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { asPayer, CHARGED_PAYERS, CHARGED_SQL, isCharged, payerForEngineAuth, PAYER_LABEL, UNKNOWN_PAYER_KEY } from "./usage-payer.js";

describe("payerForEngineAuth — the mapping, and the one it must not make", () => {
	it("maps an observed API key to the user's own provider account", () => {
		expect(payerForEngineAuth("api-key")).toBe("byok-api");
	});

	it("maps an observed subscription token to a subscription", () => {
		expect(payerForEngineAuth("subscription")).toBe("subscription");
	});

	it("maps machine-login to UNKNOWN, never to subscription", () => {
		// The whole ticket in one assertion (#346). `machine-login` means neither credential was in
		// the merged spawn env, so the CLI used whatever login it has stored — which may be a
		// claude.ai plan OR an API key configured inside the CLI. Calling it "subscription" would
		// be a confident inference from an absence, and it is the MOST COMMON resolution (what the
		// default `auto` mode produces), so it would be wrong most of the time.
		expect(payerForEngineAuth("machine-login")).toBeNull();
	});

	it("is unknown when there is no observation at all", () => {
		// A drain path with nothing to report (session end, an old runner) records unknown rather
		// than falling back to the preset's SETTING. Asking for a subscription is not getting one.
		expect(payerForEngineAuth(null)).toBeNull();
		expect(payerForEngineAuth(undefined)).toBeNull();
	});
});

describe("isCharged", () => {
	it("counts only money someone actually owes", () => {
		expect(isCharged("byok-api")).toBe(true);
		expect(isCharged("platform")).toBe(true);
	});

	it("does not count a subscription — there is no marginal charge", () => {
		// A plan allowance is consumed in tokens over a rolling window. There is no dollar figure
		// on the other side of it for a dollar ceiling to be comparing against.
		expect(isCharged("subscription")).toBe(false);
	});

	it("does not count unknown", () => {
		// Fail-open on the MONEY axis is deliberate: we may not enforce a charge we cannot
		// establish. The token ceiling is what bounds this work.
		expect(isCharged(null)).toBe(false);
		expect(isCharged(undefined)).toBe(false);
		expect(isCharged("")).toBe(false);
	});

	it("agrees with CHARGED_PAYERS", () => {
		for (const p of CHARGED_PAYERS) expect(isCharged(p)).toBe(true);
	});
});

describe("asPayer", () => {
	it("passes through the three known payers", () => {
		expect(asPayer("byok-api")).toBe("byok-api");
		expect(asPayer("subscription")).toBe("subscription");
		expect(asPayer("platform")).toBe("platform");
	});

	it("reads anything else as unknown rather than inventing a payer", () => {
		expect(asPayer("anthropic")).toBeNull(); // a VENDOR, not a payer
		expect(asPayer(null)).toBeNull();
		expect(asPayer(7)).toBeNull();
	});

	it("has a label for every bucket the aggregate can produce", () => {
		for (const key of ["byok-api", "subscription", "platform", UNKNOWN_PAYER_KEY]) {
			expect(PAYER_LABEL[key], key).toBeTruthy();
		}
	});
});

/**
 * The ratchet (#343). The bug was not a wrong threshold — it was `SUM(cost_micros)` with no payer
 * filter, in a function whose name said "spend". The next one will be a NEW sum written the same
 * way, so the guard is on the shape rather than on any one call site.
 */
describe("every dollar aggregate filters on payer", () => {
	const src = readFileSync(join(import.meta.dirname, "usage.ts"), "utf8");

	it("uses the single shared predicate rather than open-coding it", () => {
		expect(src).toContain("CHARGED_SQL");
	});

	it("leaves no SUM(cost_micros) unfiltered", () => {
		// Every money SUM in the ledger module must carry the filter within the same statement.
		// `aggregateUsage` is exempt by construction: it does not run SQL, and it reports charged
		// and total value as two separate fields precisely so a caller cannot conflate them.
		const statements = src.split(/env\.DB\.prepare\(/).slice(1);
		const moneySums = statements.filter((s) => /SUM\(\s*cost_micros/.test(s.slice(0, 1200)));
		expect(moneySums.length).toBeGreaterThan(0);
		for (const s of moneySums) {
			expect(s.slice(0, 1200), "a money SUM without the charged filter").toMatch(/CHARGED_SQL|payer IN/);
		}
	});

	it("keeps the token aggregate UNfiltered — consumption is consumption", () => {
		// The other half of the denomination fix: the token ceiling counts every row, charged or
		// not, because a runaway on an API key is the same runaway as one on a subscription.
		expect(src).toMatch(/SUM\(COALESCE\(input_tokens/);
	});

	it("states the predicate once", () => {
		expect(CHARGED_SQL).toContain("payer IN");
		expect(CHARGED_SQL).toContain("byok-api");
		expect(CHARGED_SQL).toContain("platform");
		expect(CHARGED_SQL).not.toContain("subscription");
	});
});
