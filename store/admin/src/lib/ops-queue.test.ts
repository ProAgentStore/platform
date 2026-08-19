import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STUCK_SESSION_STATUSES, capSuffix, capTitle, stuckSessionColor, stuckSessionLabel } from "./ops-queue";

/** Strip comments before matching — see store/admin/src/lib/list-query.test.ts. */
function codeOf(relPath: string): string {
	return readFileSync(join(__dirname, relPath), "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
		.join("\n");
}

/** The closed domain, read from the type that declares it rather than retyped here. */
function codingSessionStatuses(): string[] {
	const src = codeOf("../../../../workers/api/src/lib/coding-types.ts");
	const m = /export type CodingSessionStatus\s*=\s*([^;]+);/.exec(src);
	if (!m) throw new Error("could not find CodingSessionStatus — the guard has stopped measuring");
	return m[1].split("|").map((v) => v.trim().replace(/^"|"$/g, ""));
}

describe("the stuck-session legend colours values the column can actually hold (#638)", () => {
	it("reads the real domain, and it is the four-value one", () => {
		// Denominator first: a parse that found nothing would make every assertion below vacuous.
		expect(codingSessionStatuses().sort()).toEqual(["active", "ended", "error", "suspended"]);
	});

	it("colours every status the queue can return, and never on a phantom value", () => {
		const domain = codingSessionStatuses();
		// The legend used to be `failed`/`blocked` → danger, `needs_human` → warning. None of the
		// three is a member, so it had only ever rendered `text-muted`.
		for (const dead of ["failed", "needs_human", "blocked"]) {
			expect(domain, `${dead} is not a CodingSessionStatus`).not.toContain(dead);
			expect(stuckSessionColor(dead)).toBe("text-muted");
		}
		expect(stuckSessionColor("error")).toBe("text-danger");
		// `active` is in the list only via the "idle > 20m" branch — wedged, not dead.
		expect(stuckSessionColor("active")).toBe("text-warning");
		expect(stuckSessionColor("ended")).toBe("text-muted");
		expect(stuckSessionColor("suspended")).toBe("text-muted");
	});

	it("mirrors the server filter exactly, and every mirrored value is a real status", () => {
		// The mirror is the thing that can drift, so it is checked against BOTH ends: the type
		// that declares the domain, and the SQL that does the filtering.
		const domain = codingSessionStatuses();
		for (const s of STUCK_SESSION_STATUSES) expect(domain).toContain(s);

		const server = codeOf("../../../../workers/api/src/routes/admin-ops.ts");
		const m = /export const STUCK_SESSION_STATUSES = \[([^\]]+)\]/.exec(server);
		expect(m, "parsed no STUCK_SESSION_STATUSES from routes/admin-ops.ts").toBeTruthy();
		const fromServer = (m?.[1] ?? "").split(",").map((v) => v.trim().replace(/^"|"$/g, "")).filter(Boolean);
		expect(fromServer.length).toBeGreaterThan(0);
		expect([...STUCK_SESSION_STATUSES]).toEqual(fromServer);
	});

	it("says why an `active` row is in a panel headed 'stuck / failed'", () => {
		expect(stuckSessionLabel("active")).toBe("idle >20m");
		expect(stuckSessionLabel("error")).toBe("error");
	});

	it("keeps the one failure status anything writes in the filter", () => {
		// `endSession(..., "error")` at lib/coding-session-open.ts is the only writer of a failure
		// status. A filter that drops it is the original bug, which read as a green tick.
		expect([...STUCK_SESSION_STATUSES]).toContain("error");
	});
});

describe("a capped list says it is capped (#638)", () => {
	it("marks the figure once it reaches the cap", () => {
		expect(capSuffix(50, 50)).toBe("+");
		expect(capSuffix(51, 50)).toBe("+");
		expect(capTitle(50, 50)).toContain("50");
	});

	it("leaves an uncapped figure alone", () => {
		expect(capSuffix(49, 50)).toBe("");
		expect(capSuffix(0, 50)).toBe("");
		expect(capTitle(49, 50)).toBeUndefined();
	});

	it("degrades to a plain count when the server does not send a cap", () => {
		// An older API response, or one this page has not been taught about, must not grow a "+".
		expect(capSuffix(50)).toBe("");
		expect(capSuffix(50, null)).toBe("");
		expect(capTitle(50, undefined)).toBeUndefined();
	});
});
