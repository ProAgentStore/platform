import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// The console's own route table, imported rather than restated — a guard that keeps its own idea
// of the routes is a second thing to drift. `routes.ts` is React-free for exactly this reason.
import { checkConsoleLink } from "../../../../store/console/src/lib/routes";
import * as links from "./console-links";

/**
 * The guard #344 asks for: a link is a string built in a Worker, the routes are declared in a
 * React app, and until this test nothing checked that the two agree. Two producers were wrong.
 *
 * It is complete in both directions:
 *   - every function exported from `console-links.ts` is called and checked here, so a new
 *     builder is covered the moment it is added;
 *   - no other module under `workers/api/src` may build a `/console/…` string, so a producer
 *     cannot avoid the check by being written somewhere else.
 */
describe("every console link this Worker builds resolves to a real page", () => {
	// `deepLinkFor` takes a subject, not ids — it has its own exhaustive check below.
	const builders = Object.entries(links).filter(([name, v]) => typeof v === "function" && name !== "deepLinkFor") as [string, (...a: string[]) => string][];

	it("has builders to check (a silently empty sweep is the failure mode of this shape of test)", () => {
		expect(builders.length).toBeGreaterThanOrEqual(8);
	});

	for (const [name, build] of builders) {
		it(`${name}() lands on a page that exists`, () => {
			const url = build("inst_1", "id_2");
			const check = checkConsoleLink(url);
			expect(check.ok, `${name}() → ${url}: ${check.ok === false ? check.reason : ""}`).toBe(true);
		});
	}

	// Every builder takes ids from the database. An id that needs escaping must not be able to
	// invent path segments or query parameters.
	for (const [name, build] of builders) {
		it(`${name}() survives an id that would otherwise change the path`, () => {
			const url = build("a/b?c", "d/e&f=g");
			const check = checkConsoleLink(url);
			expect(check.ok, `${name}() → ${url}: ${check.ok === false ? check.reason : ""}`).toBe(true);
		});
	}
});

// #894: every notification names its SUBJECT and gets its link from `deepLinkFor`. One sample per
// kind — typed as a Record over every kind, so adding a kind fails to compile until it is here.
describe("deepLinkFor — every notification subject opens a real page (#894)", () => {
	const sample = (id: string, other: string): Record<links.NotificationSubjectKind, links.NotificationSubject> => ({
		"coding-session": { kind: "coding-session", instanceId: id, sessionId: other },
		"coding-tab": { kind: "coding-tab", instanceId: id },
		"engine-sign-in": { kind: "engine-sign-in", instanceId: id, sessionId: other },
		builds: { kind: "builds", instanceId: id, repoId: other },
		task: { kind: "task", instanceId: id, taskId: other },
		assistant: { kind: "assistant", instanceId: id },
		triggers: { kind: "triggers", instanceId: id },
		knowledge: { kind: "knowledge", instanceId: id },
		"local-browser-run": { kind: "local-browser-run", instanceId: id, runId: other },
		"secure-input": { kind: "secure-input", instanceId: id, requestId: other },
		agent: { kind: "agent", agentId: id },
		instances: { kind: "instances" },
		profile: { kind: "profile" },
	});

	for (const [kind, subject] of Object.entries(sample("inst_1", "id_2"))) {
		it(`${kind} lands on a page that exists`, () => {
			const url = links.deepLinkFor(subject);
			const check = checkConsoleLink(url);
			expect(check.ok, `${kind} → ${url}: ${check.ok === false ? check.reason : ""}`).toBe(true);
		});
	}
	for (const [kind, subject] of Object.entries(sample("a/b?c", "d/e&f=g"))) {
		it(`${kind} survives an id that would otherwise change the path`, () => {
			const check = checkConsoleLink(links.deepLinkFor(subject));
			expect(check.ok, `${kind}: ${check.ok === false ? check.reason : ""}`).toBe(true);
		});
	}

	it("opens the exact subject — the run, the session, the repo's builds, the trigger's settings", () => {
		const s = sample("i1", "x2");
		expect(links.deepLinkFor(s.task)).toBe("/console/instances/i1/tasks/x2");
		expect(links.deepLinkFor(s["coding-session"])).toBe("/console/instances/i1/coding/x2");
		expect(links.deepLinkFor(s.builds)).toBe("/console/instances/i1/coding?builds=x2");
		// A skipped trigger opens where triggers are configured, not the Board.
		expect(links.deepLinkFor(s.triggers)).toBe("/console/instances/i1/settings");
		// A sign-in with no known run still opens the instance's Coding tab, never the console home.
		expect(links.deepLinkFor({ kind: "engine-sign-in", instanceId: "i1", sessionId: null })).toBe("/console/instances/i1/coding");
		expect(links.deepLinkFor(s["secure-input"])).toBe("/console/instances/i1/secure-inputs/x2");
	});
});

describe("no producer escapes the check", () => {
	it("is the only place under workers/api/src that builds a /console path", () => {
		const offenders: string[] = [];
		for (const file of walk(join(__dirname, ".."))) {
			if (file.endsWith("/lib/console-links.ts") || /\.(test|spec)\.ts$/.test(file)) continue;
			// Strip comments first: the modules that USED to build these links explain what they no
			// longer do, and the explanation must not fail the test that protects it.
			const code = readFileSync(file, "utf8")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.split("\n")
				.map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
				.join("\n");
			if (/["'`]\/console(\/|["'`])/.test(code)) offenders.push(file.slice(file.indexOf("workers/api")));
		}
		expect(offenders, "build the link in lib/console-links.ts, where it is checked against the router").toEqual([]);
	});
});

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}
