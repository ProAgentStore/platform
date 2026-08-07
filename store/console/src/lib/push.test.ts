import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@proagentstore/sdk/client", () => ({ api: vi.fn() }));

const { api } = await import("@proagentstore/sdk/client");
const { sendTestPush } = await import("./push");

beforeEach(() => vi.clearAllMocks());

// ── #325: the diagnostic control has to be able to say "no" ──────────────────
//
// `sendTestPush` returned `Promise<void>` after swallowing the failure, so the caller could not
// tell a delivered test from a rejected request even if it wanted to — and it rendered
// "Sent ✓ (switch tabs to see it)" either way. This is the ONE button a user presses to check
// whether push works: a false ✓ sends them to debug their OS notification settings for a failure
// that is on the platform's end.
describe("sendTestPush", () => {
	it("reports true when the platform accepted the test", async () => {
		vi.mocked(api).mockResolvedValue({});
		expect(await sendTestPush()).toBe(true);
		expect(vi.mocked(api).mock.calls[0][0]).toBe("/v1/push/test");
	});

	it("reports false rather than throwing when the request is rejected", async () => {
		// Still must not throw: the caller is a click handler, and an unhandled rejection there
		// would leave the button stuck in "Sending…".
		vi.mocked(api).mockRejectedValue(new Error("500 Internal Error"));
		expect(await sendTestPush()).toBe(false);
	});
});
