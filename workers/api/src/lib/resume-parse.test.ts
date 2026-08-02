import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the collaborators so we exercise parseResumeIntoProfile's branching without
// touching Claude, the DO, or the DB. Each mock records calls so we can assert the
// exact user-facing outcome (notifyUser title/body) for a given input.
const notifyUser = vi.fn(async () => undefined);
const runUserWorkersAi = vi.fn();
const getProfile = vi.fn(async () => ({}));
const upsertProfile = vi.fn(async () => undefined);
const logError = vi.fn(async () => undefined);

vi.mock("../routes/push.js", () => ({ notifyUser: (...a: unknown[]) => notifyUser(...a) }));
vi.mock("./error-log.js", () => ({ logError: (...a: unknown[]) => logError(...a) }));
vi.mock("./profile.js", async () => {
	// Keep the real PROFILE_FIELDS shape so field-merge logic runs for real.
	const actual = await vi.importActual<typeof import("./profile.js")>("./profile.js");
	return {
		...actual,
		getProfile: (...a: unknown[]) => getProfile(...a),
		upsertProfile: (...a: unknown[]) => upsertProfile(...a),
	};
});
vi.mock("./user-ai.js", () => {
	class UserAiCredentialsError extends Error {}
	return {
		runUserWorkersAi: (...a: unknown[]) => runUserWorkersAi(...a),
		UserAiCredentialsError,
	};
});

import { parseResumeIntoProfile } from "./resume-parse.js";
import { UserAiCredentialsError as FakeUserAiCredentialsError } from "./user-ai.js";
import type { Env } from "../types.js";

function fakeEnv(): Env {
	// AGENT DO stub — only reached on the PDF success path.
	const stub = {
		fetch: vi.fn(async (req: Request) => {
			if (req.method === "DELETE") return new Response(null, { status: 200 });
			if (new URL(req.url).pathname === "/knowledge" && req.method !== "POST")
				return new Response(JSON.stringify({ documents: [] }), { status: 200 });
			return new Response(JSON.stringify({ vectorized: true }), { status: 200 }); // POST add
		}),
	};
	return { AGENT: { get: () => stub, idFromName: (n: string) => n } } as unknown as Env;
}

beforeEach(() => {
	notifyUser.mockClear();
	runUserWorkersAi.mockClear();
	getProfile.mockClear();
	upsertProfile.mockClear();
	logError.mockClear();
});

describe("parseResumeIntoProfile — non-PDF short-circuit", () => {
	it("notifies 'saved (not auto-filled)' and never calls the AI for a non-PDF", async () => {
		await parseResumeIntoProfile(fakeEnv(), "inst-1", "user-1", new Uint8Array([1, 2, 3]), "text/plain");
		expect(runUserWorkersAi).not.toHaveBeenCalled();
		expect(upsertProfile).not.toHaveBeenCalled();
		expect(notifyUser).toHaveBeenCalledTimes(1);
		const [, uid, channel, title] = notifyUser.mock.calls[0];
		expect(uid).toBe("user-1");
		expect(channel).toBe("apply");
		expect(String(title)).toContain("not auto-filled");
	});
});

describe("parseResumeIntoProfile — missing BYOK key", () => {
	it("catches UserAiCredentialsError and tells the user to add an Anthropic key", async () => {
		runUserWorkersAi.mockRejectedValueOnce(new FakeUserAiCredentialsError("no key"));
		await parseResumeIntoProfile(fakeEnv(), "inst-1", "user-1", new Uint8Array([1]), "application/pdf");
		expect(logError).not.toHaveBeenCalled(); // credentials gap is expected, not an error
		expect(notifyUser).toHaveBeenCalledTimes(1);
		const body = String(notifyUser.mock.calls[0][3]) + String(notifyUser.mock.calls[0][4]);
		expect(body).toContain("not auto-filled");
	});
});

describe("parseResumeIntoProfile — real provider failure", () => {
	it("logs the error AND alerts the user (never silent)", async () => {
		runUserWorkersAi.mockRejectedValueOnce(new Error("provider 500"));
		await parseResumeIntoProfile(fakeEnv(), "inst-1", "user-1", new Uint8Array([1]), "application/pdf");
		expect(logError).toHaveBeenCalledTimes(1);
		expect(logError.mock.calls[0][1]).toMatchObject({ source: "resume-parse", userId: "user-1" });
		expect(notifyUser).toHaveBeenCalledTimes(1);
		expect(String(notifyUser.mock.calls[0][3])).toContain("Couldn");
	});
});

describe("parseResumeIntoProfile — PDF success fills empty profile fields", () => {
	it("fills ONLY empty fields, adds a searchable KB summary, and notifies success", async () => {
		getProfile.mockResolvedValueOnce({ firstName: "Existing" }); // firstName already set → must NOT be clobbered
		runUserWorkersAi.mockResolvedValueOnce({
			tool_calls: [{ name: "save_resume", arguments: { firstName: "New", lastName: "Doe", email: "d@e.com", summaryText: "A summary of experience." } }],
		});
		await parseResumeIntoProfile(fakeEnv(), "inst-1", "user-1", new Uint8Array([1]), "application/pdf");

		expect(upsertProfile).toHaveBeenCalledTimes(1);
		const merged = upsertProfile.mock.calls[0][2] as Record<string, string>;
		expect(merged.firstName).toBe("Existing"); // preserved (was non-empty)
		expect(merged.lastName).toBe("Doe"); // filled (was empty)
		expect(merged.email).toBe("d@e.com");

		const successCall = notifyUser.mock.calls.at(-1)!;
		expect(String(successCall[3])).toContain("parsed");
		const body = String(successCall[4]);
		expect(body).toContain("filled");
		expect(body).toContain("searchable summary");
	});
});
