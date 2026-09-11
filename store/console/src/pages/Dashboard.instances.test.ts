/**
 * The Instances tab's own action (#796, #798).
 *
 * ── The pair, and why they are one change
 *
 * #796 removes the "Browse Agents" button from the Instances tab; #798 says the create/subscribe
 * flow must not be orphaned when it goes. Shipping #796 alone would have done exactly that: for a
 * user who is not a creator, `Browse.tsx` is the ONLY subscribe control in this console
 * (`AgentDetail.tsx` gained one in #797, but that page is reached from agents you own), so
 * deleting the button would have left an account with no route to a new instance at all.
 *
 * ── What is asserted here, and what cannot be
 *
 * `Dashboard.tsx` is a component and this console has no component harness — its UI is
 * Playwright's job (see `vitest.config.ts`'s note on why `.tsx` under pages/ is excluded from
 * coverage). So this is a SOURCE guard, for the same reason `AgentDetail.publish.test.ts` has
 * one: the defect class is an ABSENCE — a tab with no way to create anything — and an absence in
 * JSX is invisible to any unit test of it.
 *
 * The slice is scoped to the `{tab === "instances"}` block on purpose. `Dashboard.tsx` serves
 * FOUR routes (agents, instances, dashboard, tools) off one pathname-derived `tab`, so a guard
 * reading the whole file would pass on the Agents tab's button and prove nothing about this one.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("./Dashboard.tsx", import.meta.url).pathname, "utf8");

/**
 * JSX comments removed, so the guard reads CODE.
 *
 * Not a nicety: the block this file measures carries a comment explaining why the old control was
 * replaced, and that explanation names the old control. A guard that fires on its own postmortem
 * gets suppressed within a week — `check-bare-catch.mjs` handles the identical problem the
 * identical way, and for the identical reason.
 *
 * The slice boundaries are themselves comments, so this runs AFTER slicing, never before.
 */
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const instancesTab = code(src.slice(src.indexOf("{/* Instances */}"), src.indexOf("{/* Stats dashboard */}")));
const agentsTab = code(src.slice(src.indexOf("{/* Agents */}"), src.indexOf("{/* Instances */}")));

describe("the slice this file measures", () => {
	it("found both tabs — G1, so a renamed marker fails loudly instead of passing empty", () => {
		// Every assertion below is `expect(slice)`. An empty slice satisfies "does not contain
		// Browse agents" perfectly, which is how a guard comes to measure nothing.
		expect(instancesTab.length, "the {tab === 'instances'} block was not found in Dashboard.tsx").toBeGreaterThan(800);
		expect(agentsTab.length, "the {tab === 'agents'} block was not found in Dashboard.tsx").toBeGreaterThan(800);
		expect(instancesTab).toContain('tab === "instances"');
		expect(agentsTab).toContain('tab === "agents"');
	});
});

describe("#796 — the discovery button is gone from the Instances tab", () => {
	it("no longer offers 'Browse agents'", () => {
		expect(instancesTab).not.toContain("Browse agents");
	});

	it("and the Library page still calls itself that, so nothing was renamed away", () => {
		// The counterpart. If "Browse agents" had merely been reworded everywhere, the assertion
		// above would pass for the wrong reason.
		const browse = readFileSync(new URL("./Browse.tsx", import.meta.url).pathname, "utf8");
		expect(browse).toContain("Browse agents");
	});
});

describe("#798 — a visible way to start a new instance", () => {
	it("offers a create action, not a destination", () => {
		expect(instancesTab).toContain("+ New instance");
	});

	it("makes it the PRIMARY control, as '+ New Agent' is on the Agents tab", () => {
		// The two halves of the console should read the same way; the old control was a secondary
		// button, which is what a tab with no primary action looks like.
		expect(agentsTab).toContain('variant="primary"');
		expect(instancesTab).toContain('variant="primary"');
	});

	it("reaches the subscribe flow — the only thing that creates an instance", () => {
		// `POST /v1/instances/:id/subscribe` lives in Browse.tsx, naming form included (#450).
		// This is the deliberate part of the pair: #796 removes the framing, not the route.
		expect(instancesTab).toContain('navigate("/browse")');
	});

	it("the EMPTY state offers it too, and in the same words", () => {
		// An account with zero instances is the one that most needs this, and it is served by a
		// different branch of the same block — the arm a change to the header would not touch.
		const empty = instancesTab.slice(instancesTab.indexOf("instances.length === 0"), instancesTab.indexOf("grid grid-cols-"));
		expect(empty.length, "the zero-instances branch was not found").toBeGreaterThan(100);
		expect(empty).toContain("Subscribe to an agent");
		expect(empty).toContain('navigate("/browse")');
		expect(empty).not.toContain("Browse agents");
	});
});
