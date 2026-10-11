import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import type { LocalApplyReconciliationEnvelope } from "./contract.js";
import { LocalApplyReconciliationRuntime } from "./reconciliation-runtime.js";

const envelope = (): LocalApplyReconciliationEnvelope => ({
	type: "local_browser.apply.reconciliation", reconciliationId: "recon-1", runId: "run-1", instanceId: "runner-1", applicationId: "app-1",
	browserProfile: "isolated", applicationUrl: "https://jobs.example.test/apply", allowDomains: ["jobs.example.test"], jobIdentity: "job-1",
	materialFingerprint: { leadVersion: 1, profileVersion: "profile-1", resumeSha: "a", coverLetterSha: "b" },
});

function runtime(state: { url: string; login?: boolean; captcha?: boolean; confirmed?: boolean }) {
	const page = {
		isClosed: () => false,
		goto: async () => undefined,
		evaluate: async () => state,
	} as unknown as Page;
	return new LocalApplyReconciliationRuntime({ dataDir: "/tmp", browserFor: async () => ({ stop: async () => undefined, handoffPage: () => page }) });
}

describe("LocalApplyReconciliationRuntime", () => {
	it("does not convert a redirect or missing receipt into no-submission proof", async () => {
		const result = await runtime({ url: "https://jobs.example.test/login" }).start(envelope());
		expect(result).toMatchObject({ state: "ended", result: { state: "ambiguous", proofKind: "ambiguous_site_history" } });
	});

	it("keeps generic receipt prose and receipt-like URLs ambiguous", async () => {
		const result = await runtime({ url: "https://jobs.example.test/receipt", confirmed: true }).start(envelope());
		expect(result).toMatchObject({ state: "ended", result: { state: "ambiguous", proofKind: "ambiguous_site_history" } });
	});

	it("keeps cross-account and history-looking pages ambiguous without a validated SEEK contract", async () => {
		const result = await runtime({ url: "https://jobs.example.test/history", confirmed: true }).start(envelope());
		expect(result).toMatchObject({ state: "ended", result: { state: "ambiguous", proofKind: "ambiguous_site_history" } });
	});

	it("pauses for a passwordless login/OTP indicator", async () => {
		const result = await runtime({ url: "https://jobs.example.test/sign-in", login: true }).start(envelope());
		expect(result).toMatchObject({ state: "paused", pauseReason: "login_required" });
	});

	it("keeps a bounded authenticated inspection open but rejects non-login input, duplicate handoffs, and expired handoffs", async () => {
		let clock = 10;
		let pageState = { url: "https://jobs.example.test/sign-in", login: true };
		let ended = 0;
		const page = { isClosed: () => false, goto: async () => undefined, evaluate: async () => pageState } as unknown as Page;
		const runtime = new LocalApplyReconciliationRuntime({
			dataDir: "/tmp",
			now: () => clock,
			browserFor: async () => ({ stop: async () => undefined, handoffPage: () => page }),
			takeover: {
				open: async () => undefined, state: async () => "ready", frame: async () => ({ frame: "safe-frame", width: 1, height: 1 }),
				input: async () => undefined, end: async () => { ended += 1; },
			},
		});
		const request = { handoffId: "handoff-1", reconciliationId: "recon-1", runId: "run-1", applicationId: "app-1", browserProfile: "isolated" as const };
		await runtime.start(envelope());
		await expect(runtime.handoff(request)).resolves.toMatchObject({ state: "paused" });
		await expect(runtime.handoff(request)).rejects.toThrow("already exists");
		pageState = { url: "https://jobs.example.test/history", login: false };
		await expect(runtime.resume(request)).resolves.toMatchObject({ state: "running" });
		await expect(runtime.handoffInput({ ...request, input: { type: "text", text: "never forwarded" } })).rejects.toThrow();
		clock += 11 * 60_000;
		await expect(runtime.status({ reconciliationId: "recon-1" })).resolves.toMatchObject({ state: "ended", result: { state: "ambiguous" } });
		expect(ended).toBe(1);
	});
});
