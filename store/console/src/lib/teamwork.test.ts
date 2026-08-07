import { describe, expect, it } from "vitest";
import {
	buildClauses,
	buildConnectionConfig,
	canDelegate,
	clauseValue,
	connectionHealth,
	countdown,
	deliveryCounts,
	deliveryHeadline,
	describeDelivery,
	describeFilter,
	parseLiteral,
	parseTs,
	readFilter,
	type Connection,
	type Delivery,
} from "./teamwork";

const conn = (over: Partial<Connection> = {}): Connection => ({
	id: "c1",
	eventType: "lead.created",
	targetInstanceId: "inst-2",
	action: "run_pipeline",
	...over,
});

const del = (over: Partial<Delivery> = {}): Delivery => ({
	id: "d1",
	connectionId: "c1",
	status: "delivered",
	attempts: 1,
	...over,
});

describe("readFilter — both shapes the server accepts", () => {
	it("reads a bare array as AND", () => {
		expect(readFilter({ filter: [{ field: "suburb", op: "eq", value: "Sydney" }] })).toEqual({
			clauses: [{ field: "suburb", op: "eq", value: "Sydney" }],
			any: false,
		});
	});

	it("reads {where, any} as OR", () => {
		const got = readFilter({ filter: { where: [{ field: "a", op: "truthy" }], any: true } });
		expect(got.any).toBe(true);
		expect(got.clauses).toHaveLength(1);
	});

	it("is empty for a missing, malformed, or junk-filled filter", () => {
		expect(readFilter(undefined).clauses).toEqual([]);
		expect(readFilter({}).clauses).toEqual([]);
		expect(readFilter({ filter: "nope" }).clauses).toEqual([]);
		// A stored row could contain anything; a non-clause entry must not crash the row.
		expect(readFilter({ filter: [null, 7, { field: "ok", op: "eq" }] }).clauses).toEqual([{ field: "ok", op: "eq" }]);
	});
});

describe("describeFilter — a wired predicate has to be readable in the row", () => {
	it("joins AND clauses with 'and'", () => {
		expect(
			describeFilter({
				filter: [
					{ field: "suburb", op: "eq", value: "Sydney" },
					{ field: "rating", op: "gte", value: 4 },
				],
			}),
		).toBe('suburb eq "Sydney" and rating gte 4');
	});

	it("joins OR clauses with 'or'", () => {
		expect(describeFilter({ filter: { where: [{ field: "a", op: "truthy" }, { field: "b", op: "falsy" }], any: true } })).toBe(
			"a truthy or b falsy",
		);
	});

	it("omits the value for the ops that take none", () => {
		expect(describeFilter({ filter: [{ field: "email", op: "exists", value: "ignored" }] })).toBe("email exists");
	});

	it("renders a list value", () => {
		expect(describeFilter({ filter: [{ field: "state", op: "in", value: ["NSW", "VIC"] }] })).toBe("state in NSW / VIC");
	});

	it("returns nothing when the connection takes everything", () => {
		expect(describeFilter(undefined)).toBe("");
		expect(describeFilter({ filter: [] })).toBe("");
	});
});

describe("parseLiteral — the strict-equality trap", () => {
	it("turns a canonical number into a number", () => {
		// `eq` is `===` server-side: the string "4" never equals the number 4 in the payload,
		// so a text-typed filter silently drops every event.
		expect(parseLiteral("4")).toBe(4);
		expect(parseLiteral("4.5")).toBe(4.5);
		expect(parseLiteral("-2")).toBe(-2);
	});

	it("keeps non-round-tripping numerals as text", () => {
		expect(parseLiteral("007")).toBe("007");
		expect(parseLiteral("1,000")).toBe("1,000");
		expect(parseLiteral("2000 ")).toBe(2000); // trimmed first, then canonical
	});

	it("understands the JSON literals", () => {
		expect(parseLiteral("true")).toBe(true);
		expect(parseLiteral("false")).toBe(false);
		expect(parseLiteral("null")).toBe(null);
	});

	it("quoting is the escape hatch for a string that looks numeric", () => {
		expect(parseLiteral('"2000"')).toBe("2000");
		expect(parseLiteral('"true"')).toBe("true");
	});

	it("leaves ordinary text alone", () => {
		expect(parseLiteral("Sydney")).toBe("Sydney");
		expect(parseLiteral("")).toBe("");
	});
});

describe("clauseValue — coerce to what the server will actually compare", () => {
	it("forces a number for the numeric ops", () => {
		// The create-time validator rejects `{op:"gte", value:"4"}` outright, so a text-only
		// editor could never express "rated 4+" — the motivating example for filters at all.
		for (const op of ["gt", "gte", "lt", "lte"]) expect(clauseValue(op, "4")).toBe(4);
	});

	it("leaves an unparseable numeric value alone so the server can explain it", () => {
		expect(clauseValue("gte", "four")).toBe("four");
		expect(clauseValue("gte", "")).toBe("");
	});

	it("forces a string for contains, even when it looks numeric", () => {
		expect(clauseValue("contains", "2000")).toBe("2000");
	});

	it("splits `in` into a list and types each item", () => {
		expect(clauseValue("in", "NSW, VIC ,")).toEqual(["NSW", "VIC"]);
		expect(clauseValue("in", "1,2")).toEqual([1, 2]);
	});

	it("gives the valueless ops no value at all", () => {
		expect(clauseValue("exists", "whatever")).toBeUndefined();
		expect(clauseValue("truthy", "")).toBeUndefined();
	});
});

describe("buildClauses / buildConnectionConfig", () => {
	it("drops a row with no field yet", () => {
		expect(buildClauses([{ field: "  ", op: "eq", value: "x" }])).toEqual([]);
	});

	it("omits `value` entirely for a valueless op", () => {
		expect(buildClauses([{ field: "email", op: "exists", value: "x" }])).toEqual([{ field: "email", op: "exists" }]);
	});

	it("writes a single AND predicate in the bare-array form every stored connection uses", () => {
		expect(
			buildConnectionConfig({ action: "run_pipeline", pipeline: " site-builder ", clauses: [{ field: "suburb", op: "eq", value: "Sydney" }] }),
		).toEqual({ pipeline: "site-builder", filter: [{ field: "suburb", op: "eq", value: "Sydney" }] });
	});

	it("switches to {where, any} only for OR", () => {
		expect(buildConnectionConfig({ action: "create_task", clauses: [{ field: "a", op: "truthy", value: "" }], any: true })).toEqual({
			filter: { where: [{ field: "a", op: "truthy" }], any: true },
		});
	});

	it("carries the pipeline name only for run_pipeline", () => {
		expect(buildConnectionConfig({ action: "create_task", pipeline: "nope", clauses: [] })).toEqual({});
	});

	it("expresses the canonical example: Sydney leads rated 4+", () => {
		expect(
			buildConnectionConfig({
				action: "run_pipeline",
				pipeline: "site-builder",
				clauses: [
					{ field: "suburb", op: "eq", value: "Sydney" },
					{ field: "rating", op: "gte", value: "4" },
				],
			}).filter,
		).toEqual([
			{ field: "suburb", op: "eq", value: "Sydney" },
			{ field: "rating", op: "gte", value: 4 },
		]);
	});

	it("includes wiring params only when there are some", () => {
		expect(buildConnectionConfig({ action: "run_pipeline", clauses: [], params: {} }).params).toBeUndefined();
		expect(buildConnectionConfig({ action: "run_pipeline", clauses: [], params: { template: "cafe" } }).params).toEqual({ template: "cafe" });
	});
});

describe("parseTs / countdown", () => {
	it("reads a SQLite timestamp as UTC, not local", () => {
		// Without this a retry due in a minute reads as due ten hours ago at UTC+10.
		expect(parseTs("2026-08-04 10:00:00")).toBe(Date.parse("2026-08-04T10:00:00Z"));
		expect(parseTs("2026-08-04T10:00:00Z")).toBe(Date.parse("2026-08-04T10:00:00Z"));
	});

	it("is null for nothing or nonsense", () => {
		expect(parseTs(null)).toBeNull();
		expect(parseTs("not a date")).toBeNull();
	});

	it("counts forward in human units", () => {
		const now = Date.parse("2026-08-04T10:00:00Z");
		expect(countdown("2026-08-04T10:04:00Z", now)).toBe("in 4m");
		expect(countdown("2026-08-04T10:00:30Z", now)).toBe("in <1m");
		expect(countdown("2026-08-04T13:00:00Z", now)).toBe("in 3h");
		expect(countdown("2026-08-06T10:00:00Z", now)).toBe("in 2d");
		expect(countdown("2026-08-04T09:00:00Z", now)).toBe("due now");
		expect(countdown(null, now)).toBe("");
	});
});

describe("describeDelivery — pending alone tells you nothing", () => {
	const now = Date.parse("2026-08-04T10:00:00Z");

	it("says when a retry is coming and how many are left", () => {
		expect(describeDelivery(del({ status: "pending", attempts: 2, nextAttemptAt: "2026-08-04T10:15:00Z" }), now)).toEqual({
			tone: "warn",
			text: "2 attempts failed, retrying in 15m · 3 left",
		});
	});

	it("distinguishes a first queueing from a failed retry", () => {
		expect(describeDelivery(del({ status: "pending", attempts: 0, nextAttemptAt: "2026-08-04T10:01:00Z" }), now).text).toBe(
			"queued, next attempt in 1m",
		);
	});

	it("names the dead letter and what to do about it", () => {
		const got = describeDelivery(del({ status: "dead", attempts: 5 }), now);
		expect(got.tone).toBe("bad");
		expect(got.text).toContain("gave up after 5 attempts");
	});

	it("notes a delivery that only succeeded on a retry", () => {
		expect(describeDelivery(del({ status: "delivered", attempts: 1 }), now).text).toBe("delivered");
		expect(describeDelivery(del({ status: "delivered", attempts: 3 }), now).text).toBe("delivered after 3 attempts");
	});

	it("passes an unknown status through rather than pretending", () => {
		expect(describeDelivery(del({ status: "weird", attempts: 0 }), now)).toEqual({ tone: "idle", text: "weird" });
	});
});

describe("deliveryCounts / deliveryHeadline", () => {
	it("tallies by status and counts everything in the total", () => {
		expect(deliveryCounts([del(), del({ status: "dead" }), del({ status: "pending" }), del({ status: "??" })])).toEqual({
			delivered: 1,
			dead: 1,
			pending: 1,
			total: 4,
		});
	});

	it("leads with what is broken, then what is late, then the all-clear", () => {
		expect(deliveryHeadline({ pending: 3, delivered: 9, dead: 2, total: 14 }).text).toBe("2 events never arrived");
		expect(deliveryHeadline({ pending: 1, delivered: 9, dead: 0, total: 10 }).text).toBe("1 waiting to retry");
		expect(deliveryHeadline({ pending: 0, delivered: 9, dead: 0, total: 9 })).toEqual({ tone: "ok", text: "every event reached its agent" });
		expect(deliveryHeadline({ pending: 0, delivered: 0, dead: 0, total: 0 }).tone).toBe("idle");
	});

	it("singularises the dead-letter headline", () => {
		expect(deliveryHeadline({ pending: 0, delivered: 0, dead: 1, total: 1 }).text).toBe("1 event never arrived");
	});
});

describe("connectionHealth — surfacing the silent stop", () => {
	it("calls out a filter that has never matched", () => {
		// The whole point: `deliverEvent` only writes an outbox row for a payload that PASSES
		// the filter, so a filtered connection with zero deliveries has never once fired —
		// and looks exactly like a healthy one in a plain list.
		const c = conn({ config: { filter: [{ field: "rating", op: "gte", value: 4 }] } });
		expect(connectionHealth(c, [])).toEqual({ tone: "warn", text: "nothing has matched this filter yet" });
	});

	it("does not accuse an unfiltered connection that simply has not fired", () => {
		expect(connectionHealth(conn(), [])).toEqual({ tone: "idle", text: "no events yet" });
	});

	it("only counts this connection's own deliveries", () => {
		const c = conn();
		expect(connectionHealth(c, [del({ connectionId: "other", status: "dead" })]).tone).not.toBe("bad");
	});

	it("ranks dead above retrying above delivered", () => {
		const c = conn();
		const mixed = [del(), del({ id: "d2", status: "pending" }), del({ id: "d3", status: "dead" })];
		expect(connectionHealth(c, mixed)).toEqual({ tone: "bad", text: "1 undelivered" });
		expect(connectionHealth(c, mixed.slice(0, 2))).toEqual({ tone: "warn", text: "1 retrying" });
		expect(connectionHealth(c, mixed.slice(0, 1))).toEqual({ tone: "ok", text: "1 delivered" });
	});

	it("says a disabled connection routes nothing, before anything else", () => {
		expect(connectionHealth(conn({ enabled: false }), [del({ status: "dead" })])).toEqual({ tone: "idle", text: "disabled — it routes nothing" });
	});
});

// ── The two halves of supervision must agree (#354) ──────────────────────────────────────
//
// The picker offered supervision on every instance and the route answered 201, while the ABILITY
// to delegate is agent-level and exactly one agent declares it. The same fact now gates both, and
// it is read off the tool listing's registry `connector` rather than a copied list of tool names.
describe("canDelegate", () => {
	const t = (connector: string, reason = "ok") => ({ connector, reason });

	it("is true when the agent declares any supervision tool", () => {
		expect(canDelegate([t("github"), t("supervision")])).toBe(true);
	});

	it("is false when it declares connector tools but none that delegate", () => {
		expect(canDelegate([t("github"), t("http")])).toBe(false);
	});

	// The listing reports EVERY registry tool, including the ones this agent never declared —
	// reading "there is a supervision row" would make every agent look like a supervisor.
	it("ignores supervision tools the agent does not declare", () => {
		expect(canDelegate([t("supervision", "not_declared"), t("github")])).toBe(false);
	});

	// An owner who switched the delegation tools off has paused the wiring, not made it
	// impossible — hiding their existing links would be the wrong answer.
	it("still counts a declared tool the owner switched off", () => {
		expect(canDelegate([t("supervision", "disabled_by_owner")])).toBe(true);
	});

	it("is false for an empty listing", () => {
		expect(canDelegate([])).toBe(false);
	});
});
