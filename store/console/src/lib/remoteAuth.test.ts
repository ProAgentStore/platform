import { describe, expect, it } from "vitest";
import { REMOTE_AUTH_STATES } from "../../../../workers/api/src/lib/remote-auth";
import { remoteAuthCanSignIn, remoteAuthStatusLine } from "./remoteAuth";

describe("remote sign-in request wording (#1005)", () => {
	it("has a line for every state the Worker can report, terminal exactly where the Worker's are", () => {
		const terminal = REMOTE_AUTH_STATES.filter((s) => remoteAuthStatusLine(s).terminal);
		expect(terminal).toEqual(["connected", "denied", "expired", "cancelled", "failed"]);
	});
	it("offers Sign in only while ProAppStore can still approve it", () => {
		expect(REMOTE_AUTH_STATES.filter(remoteAuthCanSignIn)).toEqual(["pending", "approving"]);
	});
	it("never calls a request connected without the machine's authenticated read, and says nothing was granted when it ended", () => {
		expect(remoteAuthStatusLine("approved_awaiting_machine").text).not.toMatch(/connected/i);
		for (const s of ["denied", "cancelled", "expired", "failed"] as const) expect(remoteAuthStatusLine(s).text).toMatch(/Nothing was granted/);
	});
});
