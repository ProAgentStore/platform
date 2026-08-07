import { describe, expect, it } from "vitest";
import {
	describeAnswer,
	ELICITATION_METHOD,
	inputClosedNotice,
	INPUT_TTL_MS,
	isSensitiveField,
	MAX_FIELDS,
	MAX_VALUE_CHARS,
	mergeElicitedArgs,
	parseElicitation,
	pausedForInputNotice,
	resolveInputStatus,
	validateElicitationAnswer,
	type McpInputField,
} from "./mcp-elicitation.js";

/** A well-formed `elicitation/create` — the shape the spec describes and servers actually send. */
function ask(properties: Record<string, unknown>, required: string[] = [], message = "We need a couple of details.") {
	return { message, requestedSchema: { type: "object", properties, required } };
}

function parsedFields(params: unknown): McpInputField[] {
	const r = parseElicitation(ELICITATION_METHOD, params);
	if ("error" in r) throw new Error(`expected an ask, got: ${r.error}`);
	return r.ask.fields;
}

describe("parseElicitation — reading the server's question", () => {
	it("reads a flat primitive schema into renderable fields", () => {
		const fields = parsedFields(ask({ account: { type: "string", title: "Account number" }, seats: { type: "integer", minimum: 1, maximum: 9 } }, ["account"]));
		expect(fields).toHaveLength(2);
		expect(fields[0]).toMatchObject({ name: "account", type: "string", title: "Account number", required: true });
		expect(fields[1]).toMatchObject({ name: "seats", type: "integer", required: false, minimum: 1, maximum: 9 });
	});

	it("keeps an enum as a choice list, with the server's labels only when they line up", () => {
		const [ok] = parsedFields(ask({ plan: { type: "string", enum: ["a", "b"], enumNames: ["Alpha", "Beta"] } }));
		expect(ok.options).toEqual(["a", "b"]);
		expect(ok.optionLabels).toEqual(["Alpha", "Beta"]);
		// A mismatched label list would RELABEL the options, which is worse than showing raw values.
		const [mismatched] = parsedFields(ask({ plan: { type: "string", enum: ["a", "b"], enumNames: ["Alpha"] } }));
		expect(mismatched.optionLabels).toBeUndefined();
	});

	it("marks secret-looking fields sensitive so the console masks them", () => {
		const fields = parsedFields(ask({ apiKey: { type: "string" }, note: { type: "string" }, pass: { type: "string", format: "password" } }));
		expect(fields.find((f) => f.name === "apiKey")?.sensitive).toBe(true);
		expect(fields.find((f) => f.name === "pass")?.sensitive).toBe(true);
		expect(fields.find((f) => f.name === "note")?.sensitive).toBe(false);
	});

	it("drops an OPTIONAL field it cannot represent, but refuses a REQUIRED one", () => {
		// The call can still complete without an optional field, so refusing would strand a working
		// server on a value nobody needed. A required one it could never satisfy is a different thing.
		expect(parsedFields(ask({ ok: { type: "string" }, nested: { type: "object" } })).map((f) => f.name)).toEqual(["ok"]);
		const refused = parseElicitation(ELICITATION_METHOD, ask({ nested: { type: "object" } }, ["nested"]));
		expect(refused).toEqual({ error: expect.stringContaining("cannot collect") });
	});

	it("accepts a pure confirmation (a message and no fields)", () => {
		const r = parseElicitation(ELICITATION_METHOD, ask({}, [], "Delete the staging site?"));
		expect("ask" in r && r.ask.fields).toEqual([]);
		expect("ask" in r && r.ask.message).toBe("Delete the staging site?");
	});

	// ── MALFORMED INPUT-REQUIRED PAYLOADS (an acceptance criterion of #264) ──────────────────
	//
	// Each of these must be an ERROR rather than a repair. A half-understood ask produces a form
	// that collects the wrong values, sends them to a remote server, and reports the result as the
	// call the user meant — worse than the honest refusal the caller falls back to.
	it.each([
		["a different server→client request", "sampling/createMessage", ask({ a: { type: "string" } })],
		["no params at all", ELICITATION_METHOD, null],
		["params that are not an object", ELICITATION_METHOD, "give me the account number"],
		["no message to show a human", ELICITATION_METHOD, { requestedSchema: { type: "object", properties: { a: { type: "string" } } } }],
		["no requestedSchema", ELICITATION_METHOD, { message: "Account number?" }],
		["a requestedSchema with no properties object", ELICITATION_METHOD, { message: "Account number?", requestedSchema: { type: "object" } }],
		["properties that are not an object", ELICITATION_METHOD, { message: "?", requestedSchema: { type: "object", properties: [1, 2] } }],
	])("refuses %s", (_label, method, params) => {
		const r = parseElicitation(method, params);
		expect("error" in r).toBe(true);
	});

	it("refuses an ask with more fields than a person answers in one round", () => {
		const properties: Record<string, unknown> = {};
		for (let i = 0; i <= MAX_FIELDS; i++) properties[`f${i}`] = { type: "string" };
		expect(parseElicitation(ELICITATION_METHOD, ask(properties))).toEqual({ error: expect.stringContaining(`${MAX_FIELDS}`) });
	});
});

describe("isSensitiveField", () => {
	it("splits snake_case and camelCase, and catches the joined form", () => {
		expect(isSensitiveField("api_key")).toBe(true);
		expect(isSensitiveField("apiKey")).toBe(true);
		expect(isSensitiveField("user_password")).toBe(true);
		expect(isSensitiveField("anything", "password")).toBe(true);
	});

	it("does not mask an ordinary field that merely contains a word", () => {
		expect(isSensitiveField("pinned_count")).toBe(false);
		expect(isSensitiveField("street")).toBe(false);
	});
});

describe("validateElicitationAnswer", () => {
	const fields = parsedFields(
		ask(
			{
				account: { type: "string", minLength: 3, maxLength: 8 },
				seats: { type: "integer", minimum: 1, maximum: 4 },
				plan: { type: "string", enum: ["pro", "free"] },
				agree: { type: "boolean" },
			},
			["account"],
		),
	);

	it("coerces the shapes an HTML form actually produces", () => {
		const r = validateElicitationAnswer(fields, { account: "AB1234", seats: "3", agree: "true", plan: "pro" });
		expect(r).toEqual({ ok: true, values: { account: "AB1234", seats: 3, agree: true, plan: "pro" } });
	});

	it("refuses a missing required value, naming it", () => {
		expect(validateElicitationAnswer(fields, { seats: 2 })).toEqual({ ok: false, error: expect.stringContaining("account") });
	});

	it("enforces the server's own bounds and choices", () => {
		expect(validateElicitationAnswer(fields, { account: "AB", seats: 1 }).ok).toBe(false);
		expect(validateElicitationAnswer(fields, { account: "AB1234", seats: 9 }).ok).toBe(false);
		expect(validateElicitationAnswer(fields, { account: "AB1234", seats: 1.5 }).ok).toBe(false);
		expect(validateElicitationAnswer(fields, { account: "AB1234", plan: "enterprise" }).ok).toBe(false);
	});

	it("caps a single value, whatever the server's schema said", () => {
		const long = parsedFields(ask({ note: { type: "string" } }));
		expect(validateElicitationAnswer(long, { note: "x".repeat(MAX_VALUE_CHARS + 1) }).ok).toBe(false);
	});

	it("drops keys the server never asked for", () => {
		// The answer is merged into the remote tool's arguments, so passing extra keys through would
		// make this route a way to rewrite the pending call — the thing the encrypted payload prevents.
		const r = validateElicitationAnswer(fields, { account: "AB1234", url: "https://evil.example.com" });
		expect(r).toEqual({ ok: true, values: { account: "AB1234" } });
	});

	it("refuses anything that is not an object", () => {
		expect(validateElicitationAnswer(fields, "AB1234").ok).toBe(false);
	});
});

describe("mergeElicitedArgs", () => {
	it("lets the human's answer win over what the call already carried", () => {
		// The server elicited because what it had was missing or unusable; re-sending the original
		// value would reproduce the ask verbatim and the round would achieve nothing.
		expect(mergeElicitedArgs({ site: "x", account: "wrong" }, { account: "right" })).toEqual({ site: "x", account: "right" });
	});
});

describe("describeAnswer — what may be written down", () => {
	it("returns key names and a size, never a value", () => {
		const d = describeAnswer({ password: "hunter2", seats: 3 });
		expect(d.keys).toEqual(["password", "seats"]);
		expect(d.bytes).toBeGreaterThan(0);
		expect(JSON.stringify(d)).not.toContain("hunter2");
	});
});

describe("resolveInputStatus — the timeout is a fact about the clock", () => {
	const t0 = Date.parse("2026-08-08T12:00:00Z");

	it("is pending inside the window", () => {
		expect(resolveInputStatus({ status: "pending", expiresAt: new Date(t0 + INPUT_TTL_MS).toISOString() }, t0)).toBe("pending");
	});

	it("is expired past the deadline even though nothing has swept it", () => {
		// Derived rather than stored, so the console badge, the resume gate and the sweeper cannot
		// disagree about whether an answer still counts.
		expect(resolveInputStatus({ status: "pending", expiresAt: new Date(t0 - 1).toISOString() }, t0)).toBe("expired");
	});

	it("keeps a decided status whatever the clock says", () => {
		expect(resolveInputStatus({ status: "cancelled", expiresAt: new Date(t0 - 1).toISOString() }, t0)).toBe("cancelled");
		expect(resolveInputStatus({ status: "answered", expiresAt: new Date(t0 + 1).toISOString() }, t0)).toBe("answered");
	});

	it("treats an unparseable deadline as still open rather than silently dead", () => {
		expect(resolveInputStatus({ status: "pending", expiresAt: null }, t0)).toBe("pending");
	});
});

describe("the sentences", () => {
	it("tells the model the call did not complete and not to invent the values", () => {
		const notice = pausedForInputNotice("create_site", "https://builder.example.com/mcp", "Which suburb?", 1);
		expect(notice).toMatch(/did NOT complete/);
		expect(notice).toMatch(/nothing was submitted/i);
		expect(notice).toMatch(/Do not invent the values/);
		expect(notice).toMatch(/do not report this as done/i);
	});

	it("names a confirmation as a confirmation rather than 0 values", () => {
		expect(pausedForInputNotice("delete_site", "https://x.example.com/mcp", "Sure?", 0)).toMatch(/a confirmation/);
	});

	it("names the remedy for every closed state", () => {
		expect(inputClosedNotice("expired")).toMatch(/timed out/i);
		expect(inputClosedNotice("cancelled")).toMatch(/nothing was sent/i);
		expect(inputClosedNotice("answered")).toMatch(/already answered/i);
		expect(inputClosedNotice("pending")).toMatch(/waiting/i);
	});
});
