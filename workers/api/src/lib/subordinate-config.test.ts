import { describe, expect, it } from "vitest";
import { CONFIG_LEGEND, MAX_RULES_CHARS, objectiveConflict, resolveSubordinateConfig } from "./subordinate-config.js";
import type { SettingsField } from "./agent-capabilities.js";

/** The field migration 0091 appends to every coding agent's schema. */
const MERGE_FIELD: SettingsField = {
	id: "merge_policy",
	label: "Merge authority",
	type: "select",
	default: "merge",
	options: [
		{ value: "merge", label: "May merge to main (current behaviour)" },
		{ value: "pr", label: "Open a pull request, never merge" },
		{ value: "none", label: "Commit only — no push, no pull request" },
	],
};

const repo = (name: string, mergePolicy = "") => ({ name, githubRepo: `org/${name}`, mergePolicy });

describe("merge authority — the field the Lead never looked at (#339)", () => {
	it("names the policy, where it came from, and what it permits", () => {
		const c = resolveSubordinateConfig({
			config: JSON.stringify({ settings: { merge_policy: "pr" } }),
			agentConfig: "{}",
			settingsSchema: [MERGE_FIELD],
			repos: [repo("platform")],
		});
		expect(c.mergeAuthority.policy).toBe("pr");
		expect(c.mergeAuthority.source).toBe("agent");
		// Plain words, not an enum: the supervisor should not have to interpret "pr".
		expect(c.mergeAuthority.permits).toMatch(/must NOT merge/);
	});

	it("reports the PERMISSIVE default as what it is, rather than staying silent", () => {
		// The incident's actual state: `merge_policy: "merge"` — "May merge to main". The Lead
		// answered "it's working through PRs, not direct commits to main. That's the correct
		// flow", which is the opposite of what the configuration said.
		const c = resolveSubordinateConfig({ config: "{}", agentConfig: "{}", settingsSchema: [MERGE_FIELD], repos: [repo("platform")] });
		expect(c.mergeAuthority.policy).toBe("merge");
		expect(c.mergeAuthority.source).toBe("default");
		expect(c.mergeAuthority.permits).toMatch(/may merge to the trunk/);
	});

	it("a repo override outranks the agent setting, and says so per repo", () => {
		const c = resolveSubordinateConfig({
			config: JSON.stringify({ settings: { merge_policy: "merge" } }),
			agentConfig: "{}",
			settingsSchema: [MERGE_FIELD],
			repos: [repo("platform", "pr")],
		});
		expect(c.mergeAuthority.policy).toBe("pr");
		expect(c.mergeAuthority.source).toBe("repo");
		expect(c.mergeAuthority.perRepo).toEqual([{ repo: "org/platform", policy: "pr", source: "repo" }]);
	});

	it("refuses one answer when the repos disagree", () => {
		// Picking either would be the same confident-wrong-answer this module exists to stop.
		const c = resolveSubordinateConfig({
			config: "{}",
			agentConfig: "{}",
			settingsSchema: [MERGE_FIELD],
			repos: [repo("a", "pr"), repo("b", "merge")],
		});
		expect(c.mergeAuthority.policy).toBeNull();
		expect(c.mergeAuthority.note).toMatch(/never with a single yes or no/);
		expect(c.mergeAuthority.perRepo?.map((r) => r.policy)).toEqual(["pr", "merge"]);
	});

	it("says merge authority does not apply to an agent with no repository", () => {
		const c = resolveSubordinateConfig({ config: "{}", agentConfig: "{}", repos: [] });
		expect(c.mergeAuthority.applies).toBe(false);
		expect(c.mergeAuthority.note).toMatch(/no repository attached/);
	});

	it("UNREAD repos are not reported as no repos", () => {
		// `null` vs `[]`. Reporting "it has no repositories" because a query failed is the
		// confident-empty this whole class of bug is made of.
		const c = resolveSubordinateConfig({ config: "{}", agentConfig: "{}", settingsSchema: [MERGE_FIELD], repos: null });
		expect(c.mergeAuthority.applies).toBe(true);
		expect(c.mergeAuthority.note).toMatch(/repositories were not read/);
	});
});

describe("the four things 'instructions' can mean, kept apart", () => {
	const full = resolveSubordinateConfig({
		config: JSON.stringify({
			specialInstructions: "Never touch the release branch.",
			behaviour: { technicality: 80 },
			settings: { merge_policy: "pr" },
		}),
		agentConfig: JSON.stringify({ behaviour: { verbosity: "brief" } }),
		settingsSchema: [MERGE_FIELD],
		repos: [repo("platform")],
	});

	it("carries the owner's standing rules as their own layer", () => {
		expect(full.specialInstructions).toEqual({ set: true, text: "Never touch the release branch." });
	});

	it("carries behaviour as PROSE, merged creator-under-subscriber", () => {
		const ids = full.behaviour.fields.map((f) => f.id).sort();
		expect(ids).toEqual(["technicality", "verbosity"]);
		// The band prose, never the raw number — a bare scalar is what models overfit.
		expect(full.behaviour.fields.find((f) => f.id === "technicality")?.description).not.toBe("80");
		expect(full.behaviour.fields.find((f) => f.id === "technicality")?.description.length).toBeGreaterThan(10);
	});

	it("carries typed settings with their LABELS, and whether the owner set them", () => {
		expect(full.settings.values).toEqual([{ id: "merge_policy", label: "Merge authority", value: "pr", set: true }]);
	});

	it("distinguishes a schema default from a value the owner chose", () => {
		const c = resolveSubordinateConfig({ config: "{}", agentConfig: "{}", settingsSchema: [MERGE_FIELD], repos: [repo("p")] });
		expect(c.settings.values).toEqual([{ id: "merge_policy", label: "Merge authority", value: "merge", set: false }]);
		expect(c.settings.set).toBe(false);
	});

	it("an empty store is reported as empty, not as unknown", () => {
		const c = resolveSubordinateConfig({ config: "{}", agentConfig: "{}", repos: [] });
		expect(c.available).toBe(true);
		expect(c.specialInstructions).toEqual({ set: false });
		expect(c.behaviour.set).toBe(false);
	});

	it("caps standing rules and says it did, rather than silently truncating", () => {
		const c = resolveSubordinateConfig({
			config: JSON.stringify({ specialInstructions: "x".repeat(MAX_RULES_CHARS + 50) }),
			agentConfig: "{}",
			repos: [],
		});
		expect(c.specialInstructions.text).toHaveLength(MAX_RULES_CHARS);
		expect(c.specialInstructions.truncated).toBe(true);
	});
});

describe("not available to me, rather than a confident empty (#259/#320 posture)", () => {
	it("a config that will not parse is UNKNOWN, not unconfigured", () => {
		const c = resolveSubordinateConfig({ config: "{not json", agentConfig: "{}", repos: [] });
		expect(c.available).toBe(false);
		expect(c.note).toMatch(/NOT AVAILABLE/);
		// And nothing below it may be read as a fact.
		expect(c.mergeAuthority.applies).toBe(false);
		expect(c.specialInstructions.set).toBe(false);
	});

	it("a fresh instance with no config at all is available and empty", () => {
		const c = resolveSubordinateConfig({ config: null, agentConfig: null, repos: [] });
		expect(c.available).toBe(true);
	});
});

describe("objectiveConflict — an objective is not a permission", () => {
	it("flags an objective that orders a merge the policy forbids", () => {
		// Verbatim from the ticket: the run was told to "open a PR and merge it", and the Lead
		// repeated that back as the flow. Under `pr` that objective exceeds the policy.
		const msg = objectiveConflict("pr", "Read each open issue, implement a fix, commit, push, open a PR, and merge it.");
		expect(msg).toMatch(/EXCEEDS the policy/);
		expect(msg).toMatch(/cannot grant permission/);
	});

	it("is silent under the permissive default — no invented conflict", () => {
		expect(objectiveConflict("merge", "open a PR and merge it")).toBeNull();
	});

	it("is silent when the objective asks for nothing the policy forbids", () => {
		expect(objectiveConflict("pr", "Get the test suite green.")).toBeNull();
	});

	it("says nothing when the policy itself is unknown", () => {
		expect(objectiveConflict(null, "merge the PR")).toBeNull();
	});
});

describe("the legend travels in the payload, not only in a tool description", () => {
	it("names every layer, and rules memory out", () => {
		for (const key of ["mergeAuthority", "specialInstructions", "behaviour", "settings"]) {
			expect(CONFIG_LEGEND).toContain(`config.${key}`);
		}
		expect(CONFIG_LEGEND).toMatch(/Memory is NOT in this view/);
	});

	it("says plainly that an objective is not the configuration", () => {
		expect(CONFIG_LEGEND).toMatch(/objective` is a one-off ask and is NOT configuration/);
		expect(CONFIG_LEGEND).toMatch(/available: false/);
	});
});
