import { describe, expect, it } from "vitest";
import { answerPayload, closedNote, controlFor, initialDraft, labelFor, missingRequired, optionLabel, pendingOnly, timeLeft, type McpInputField, type McpInputRequest } from "./mcpInputRequests";

function field(over: Partial<McpInputField> = {}): McpInputField {
	return { name: "suburb", type: "string", required: false, sensitive: false, ...over };
}

describe("controlFor", () => {
	it("picks the control from the field, not from a guess at the page", () => {
		expect(controlFor(field({ type: "boolean" }))).toBe("checkbox");
		expect(controlFor(field({ options: ["a", "b"] }))).toBe("select");
		expect(controlFor(field({ type: "integer" }))).toBe("number");
		expect(controlFor(field({ sensitive: true }))).toBe("password");
		expect(controlFor(field())).toBe("text");
	});

	it("prefers a choice list over masking, because a masked dropdown is unusable", () => {
		expect(controlFor(field({ options: ["a"], sensitive: true }))).toBe("select");
	});
});

describe("labels", () => {
	it("falls back to the raw name so a title-less field is still fillable", () => {
		expect(labelFor(field({ title: "Suburb" }))).toBe("Suburb");
		expect(labelFor(field({ title: "   " }))).toBe("suburb");
	});

	it("uses the server's enum labels when it supplied them", () => {
		const f = field({ options: ["pro", "free"], optionLabels: ["Pro", "Free"] });
		expect(optionLabel(f, 0)).toBe("Pro");
		expect(optionLabel(field({ options: ["pro"] }), 0)).toBe("pro");
	});
});

describe("initialDraft", () => {
	it("pre-fills nothing, including selects and booleans", () => {
		// A pre-filled answer is one the user did not give, and these answers are merged into a
		// remote call that may do something irreversible.
		expect(initialDraft([field({ name: "a" }), field({ name: "b", type: "boolean" }), field({ name: "c", options: ["x", "y"] })])).toEqual({ a: "", b: false, c: "" });
	});
});

describe("missingRequired", () => {
	it("names the empty required fields, by label", () => {
		const fields = [field({ name: "suburb", title: "Suburb", required: true }), field({ name: "note" })];
		expect(missingRequired(fields, { suburb: "", note: "" })).toEqual(["Suburb"]);
		expect(missingRequired(fields, { suburb: "Newtown", note: "" })).toEqual([]);
	});

	it("treats a required checkbox as answered either way", () => {
		// Requiring it to be TICKED would silently turn a yes/no question into a consent box.
		expect(missingRequired([field({ name: "ok", type: "boolean", required: true })], { ok: false })).toEqual([]);
	});
});

describe("answerPayload", () => {
	it("drops blank optional fields rather than sending an empty string", () => {
		// "" is a VALUE to a remote tool; "I left it blank" is not.
		const fields = [field({ name: "suburb" }), field({ name: "note" }), field({ name: "hero", type: "boolean" })];
		expect(answerPayload(fields, { suburb: "Newtown", note: "  ", hero: false })).toEqual({ suburb: "Newtown", hero: false });
	});

	it("sends only the fields the server asked for", () => {
		expect(answerPayload([field({ name: "suburb" })], { suburb: "Newtown", url: "https://evil.example.com" })).toEqual({ suburb: "Newtown" });
	});
});

describe("timeLeft", () => {
	const now = Date.parse("2026-08-08T12:00:00Z");

	it("counts down in minutes, and says less than a minute at the end", () => {
		expect(timeLeft(new Date(now + 12 * 60_000).toISOString(), now)).toBe("12 minutes left");
		expect(timeLeft(new Date(now + 20_000).toISOString(), now)).toBe("less than a minute left");
	});

	it("returns null once it has run out, so the card shows the closed state instead of a negative", () => {
		expect(timeLeft(new Date(now - 1).toISOString(), now)).toBeNull();
		expect(timeLeft("not a date", now)).toBeNull();
	});
});

describe("closedNote + pendingOnly", () => {
	it("says nothing was sent for the two closed states a user causes", () => {
		expect(closedNote("expired")).toMatch(/nothing was sent/i);
		expect(closedNote("cancelled")).toMatch(/nothing was sent/i);
		expect(closedNote("pending")).toBe("");
	});

	it("shows only what is still answerable", () => {
		const req = (id: string, status: McpInputRequest["status"]): McpInputRequest => ({
			id,
			endpoint: "https://x.example.com/mcp",
			tool: "t",
			status,
			round: 1,
			maxRounds: 3,
			message: "?",
			fields: [],
			traceId: null,
			expiresAt: "2026-08-08T12:30:00Z",
			createdAt: "2026-08-08T12:00:00Z",
		});
		expect(pendingOnly([req("a", "pending"), req("b", "answered"), req("c", "expired")]).map((r) => r.id)).toEqual(["a"]);
	});
});
