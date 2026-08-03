import { describe, expect, it } from "vitest";
import {
	authorityForDelegation,
	consentInstanceOf,
	describeAuthority,
	isDelegated,
	ownAuthority,
	type ExecutionAuthority,
} from "./execution-authority.js";

const SUPERVISOR = "sup-1";
const SUBORDINATE = "sub-1";
const USER = "u1";

describe("authorityForDelegation", () => {
	it("runs as the SUBORDINATE — the executor, never the asker", () => {
		const a = authorityForDelegation({ subordinateInstanceId: SUBORDINATE, supervisorInstanceId: SUPERVISOR, userId: USER });
		expect(a.instanceId).toBe(SUBORDINATE);
		expect(a.onBehalfOf).toBe(SUPERVISOR);
	});

	it("carries the owner's identity — that is what a delegation actually lends", () => {
		const a = authorityForDelegation({ subordinateInstanceId: SUBORDINATE, supervisorInstanceId: SUPERVISOR, userId: USER });
		expect(a.userId).toBe(USER);
	});

	it("does not record an asker for self-delegation", () => {
		const a = authorityForDelegation({ subordinateInstanceId: SUBORDINATE, supervisorInstanceId: SUBORDINATE, userId: USER });
		expect(a.onBehalfOf).toBeUndefined();
		expect(isDelegated(a)).toBe(false);
	});
});

describe("consentInstanceOf — the non-inheritance invariant", () => {
	it("DOWN-LENDING: a supervisor cannot widen a subordinate's reach by delegating to it", () => {
		// The supervisor may hold write consent the subordinate does not. Consent must be
		// evaluated against the subordinate, so the write stays refused.
		const a = authorityForDelegation({ subordinateInstanceId: SUBORDINATE, supervisorInstanceId: SUPERVISOR, userId: USER });
		expect(consentInstanceOf(a)).toBe(SUBORDINATE);
		expect(consentInstanceOf(a)).not.toBe(SUPERVISOR);
	});

	it("UP-BORROWING: a supervisor cannot gain a subordinate's reach by delegating through it", () => {
		// Mirror case. The subordinate may hold a connector grant the supervisor lacks; work the
		// SUPERVISOR executes must still resolve to the supervisor.
		const a = ownAuthority(SUPERVISOR, USER);
		expect(consentInstanceOf(a)).toBe(SUPERVISOR);
		expect(consentInstanceOf(a)).not.toBe(SUBORDINATE);
	});

	it("never consults onBehalfOf, even when it is the only other id present", () => {
		// The whole bypass would be one accidental `?? onBehalfOf`. Pin it.
		const a: ExecutionAuthority = { instanceId: SUBORDINATE, userId: USER, onBehalfOf: SUPERVISOR };
		expect(consentInstanceOf(a)).toBe(SUBORDINATE);
	});

	it("is stable across nesting depth — a 3-level chain still resolves to the executor", () => {
		// root > mid > leaf. Work at the leaf runs as the leaf regardless of how deep the ask
		// originated, so authority cannot accumulate down a tower.
		const mid = authorityForDelegation({ subordinateInstanceId: "mid", supervisorInstanceId: "root", userId: USER });
		const leaf = authorityForDelegation({ subordinateInstanceId: "leaf", supervisorInstanceId: mid.instanceId, userId: USER });
		expect(consentInstanceOf(leaf)).toBe("leaf");
		expect(leaf.onBehalfOf).toBe("mid");
	});
});

describe("audit attribution", () => {
	it("distinguishes who asked from whose authority ran", () => {
		const a = authorityForDelegation({ subordinateInstanceId: SUBORDINATE, supervisorInstanceId: SUPERVISOR, userId: USER });
		const text = describeAuthority(a);
		expect(text).toContain(SUBORDINATE);
		expect(text).toContain(SUPERVISOR);
		expect(text).toMatch(/ran as sub-1/);
	});

	it("stays terse for undelegated work", () => {
		expect(describeAuthority(ownAuthority(SUPERVISOR, USER))).toBe(`ran as ${SUPERVISOR}`);
	});
});
