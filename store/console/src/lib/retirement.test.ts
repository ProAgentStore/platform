/**
 * What the console does with a server-declared retirement (#979), and where it must be wired.
 *
 * Two halves, for the reason `Dashboard.instances.test.ts` gives: this console has no component
 * harness, so the VALUES are unit-tested here and the WIRING is asserted over the source. The
 * defect class #979 reports is an absence — a dead agent that renders like a live one — and an
 * absence in JSX is invisible to any unit test of it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type InstanceRetirement, isRetired, replacementRoutes, retiredTitle, retirementOf } from "./retirement";

const RETIREMENT: InstanceRetirement = {
	workflow: "JOB_APPLY",
	status: "retired",
	label: "Retired — disabled",
	since: "2026-10-08",
	summary: "This agent's cloud-brain job-application workflow was retired.",
	migration: "Use the Scout → Tailor → Runner pipeline.",
	preserved: "Its board, tasks and activity stay readable.",
	replacement: {
		pipeline: "Scout → Tailor → Runner",
		roles: [
			{ role: "scout", runtime: "local_browser", label: "Job Search Scout", does: "finds and triages job leads" },
			{ role: "runner", runtime: "local_apply", label: "Application Runner", does: "fills the employer's form" },
		],
	},
	replacements: [
		{ role: "scout", runtime: "local_browser", label: "Job Search Scout", does: "finds and triages job leads", instanceId: "i-scout", instanceName: "My Scout", consolePath: "/instances/i-scout" },
		{ role: "runner", runtime: "local_apply", label: "Application Runner", does: "fills the employer's form", instanceId: null, instanceName: null, consolePath: null },
	],
	missingRoles: ["runner"],
};

describe("reading the server's verdict", () => {
	it("is retired only when the server says so — the console never decides this", () => {
		expect(isRetired({ retirement: RETIREMENT })).toBe(true);
		expect(isRetired({})).toBe(false);
		expect(isRetired(null)).toBe(false);
		expect(isRetired(undefined)).toBe(false);
		expect(retirementOf({ retirement: RETIREMENT })?.label).toBe("Retired — disabled");
		expect(retirementOf({})).toBeNull();
	});

	it("the badge's tooltip carries the verdict, the date and what to use instead", () => {
		const title = retiredTitle(RETIREMENT);
		expect(title).toContain("Retired — disabled");
		expect(title).toContain("2026-10-08");
		expect(title).toContain("Scout → Tailor → Runner");
	});
});

describe("the route out of a dead agent", () => {
	it("links the owner's own instance, and PROMPTS for the role they do not have", () => {
		const routes = replacementRoutes(RETIREMENT);
		expect(routes[0]).toMatchObject({ key: "scout", label: "My Scout", href: "/instances/i-scout", hint: null });
		expect(routes[1]).toMatchObject({ key: "runner", label: "Application Runner", href: null });
		// Never an empty row: a dead link is worse here than a sentence, because this banner is the
		// only place the owner learns their agent will not run.
		expect(routes[1].hint).toMatch(/no Application Runner yet/);
	});

	it("falls back to the static roles when the server resolved no roster", () => {
		// An older server, or one that could not resolve the owner's instances. The banner must still
		// explain what replaces this agent rather than render an empty list.
		const routes = replacementRoutes({ ...RETIREMENT, replacements: undefined, missingRoles: undefined });
		expect(routes.map((r) => r.key)).toEqual(["scout", "runner"]);
		expect(routes.every((r) => r.href === null && !!r.hint)).toBe(true);
	});

	it("says what each part DOES — the banner has to be readable by someone who never used the old agent", () => {
		expect(replacementRoutes(RETIREMENT).map((r) => r.does)).toEqual(["finds and triages job leads", "fills the employer's form"]);
	});
});

/**
 * The wiring. Each assertion names a surface #979 lists: the instance header, the instance page,
 * the dashboard card, and the run/start control.
 */
describe("where the retirement is rendered (source guard)", () => {
	const detail = readFileSync("store/console/src/pages/InstanceDetail.tsx", "utf8");
	const dashboard = readFileSync("store/console/src/pages/Dashboard.tsx", "utf8");

	it("the instance page resolves it from the record, once", () => {
		expect(detail).toContain("retirementOf(instance)");
	});

	it("the instance HEADER carries the badge", () => {
		expect(detail).toMatch(/retirement && <RetiredBadge retirement=\{retirement\}/);
	});

	it("the instance page carries the BANNER, outside any per-tab branch, with a route out", () => {
		expect(detail).toMatch(/retirement && <RetiredNotice retirement=\{retirement\} onOpen=/);
		// Above the tab content, beside the other banner that shows on every surface for the same
		// reason — not inside `tab === "chat"`, which would hide it on the board.
		const banner = detail.indexOf("<RetiredNotice");
		const tabContent = detail.indexOf('{tab === "chat" && (');
		expect(banner).toBeGreaterThan(-1);
		expect(banner).toBeLessThan(tabContent);
	});

	it("the Loop STARTER is gated on it — a control the server answers 410 for is not offered", () => {
		expect(detail).toMatch(/\) : retirement \? null : \(/);
	});

	it("the dashboard card carries the badge", () => {
		expect(dashboard).toMatch(/inst\.retirement && <RetiredBadge/);
	});
});
