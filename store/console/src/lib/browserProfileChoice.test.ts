/**
 * The one browser-profile choice (#1601): every saved pair reads back as the launch it already produced (the table in the issue,
 * verified against `BrowserSessions.browserFor`), and every choice writes the pair that launches what its label says.
 */
import { describe, expect, it } from "vitest";
import {
	LAUNCH_LABELS, choiceLabel, defaultLaunch, effectiveLaunch, launchFor, ownProfileBlock, selectedChoice, writesFor,
	type LaunchProfile, type ProfileChoice, type ProfileInputs,
} from "./browserProfileChoice";

const base: ProfileInputs = { browserProfile: "isolated", instanceEngine: null, instanceProfile: null, agentEngine: null, agentProfile: null };
const at = (over: Partial<ProfileInputs>): ProfileInputs => ({ ...base, ...over });

/** Each saved row of the issue's table: what is stored, what it launches today, and the choice the control must show. */
const ROWS: Array<{ row: string; inputs: ProfileInputs; launches: LaunchProfile; shows: ProfileChoice }> = [
	{ row: "1 isolated + ephemeral", inputs: at({ instanceProfile: "ephemeral" }), launches: "fresh", shows: "fresh" },
	{ row: "2 isolated + persistent", inputs: at({ instanceProfile: "persistent" }), launches: "kept", shows: "kept" },
	{ row: "3 isolated + not set, no engine (legacy)", inputs: at({}), launches: "fresh", shows: "default" },
	{ row: "4 default + ephemeral", inputs: at({ browserProfile: "default", instanceProfile: "ephemeral" }), launches: "fresh", shows: "fresh" },
	{ row: "5 default + persistent", inputs: at({ browserProfile: "default", instanceProfile: "persistent" }), launches: "kept", shows: "kept" },
	{ row: "6 default + not set, no engine (legacy)", inputs: at({ browserProfile: "default" }), launches: "own", shows: "own" },
	{ row: "6b default + not set, engine set (derived persistent)", inputs: at({ browserProfile: "default", instanceEngine: "chrome" }), launches: "kept", shows: "kept" },
];

describe("what the saved settings launch today is what the control shows (#1601)", () => {
	for (const { row, inputs, launches, shows } of ROWS) {
		it(`row ${row}: launches ${launches}, shows ${shows}`, () => {
			expect(effectiveLaunch(inputs)).toBe(launches);
			expect(selectedChoice(inputs)).toBe(shows);
		});
	}

	it("an engine alone (isolated, profile unset) derives an ephemeral profile: fresh, shown as the agent's default", () => {
		const i = at({ instanceEngine: "firefox" });
		expect(effectiveLaunch(i)).toBe("fresh");
		expect(selectedChoice(i)).toBe("default");
	});

	it("the agent's own defaults count: its profile policy decides, and nothing set here reads as its default", () => {
		const i = at({ agentProfile: "persistent" });
		expect(effectiveLaunch(i)).toBe("kept");
		expect(selectedChoice(i)).toBe("default");
		expect(choiceLabel("default", i)).toBe(`Use the agent’s default (now: ${LAUNCH_LABELS.kept})`);
	});

	it("the disagreement case: the two stores disagree and the control shows what takes effect at launch", () => {
		// browserProfile says "own" but the instance has a profile policy: the managed path never uses the owner's profile.
		expect(selectedChoice(at({ browserProfile: "default", instanceProfile: "ephemeral" }))).toBe("fresh");
		// browserProfile says fresh but an agent default sets persistent: the instance override is what wins when set.
		expect(selectedChoice(at({ agentProfile: "persistent", instanceProfile: "ephemeral" }))).toBe("fresh");
	});

	it("the mapping is the runner's: policy first, then the engine-derived policy, then the legacy path", () => {
		expect(launchFor("default", "chrome", "ephemeral")).toBe("fresh");
		expect(launchFor("isolated", "chrome", "persistent")).toBe("kept");
		expect(launchFor("default", null, null)).toBe("own");
		expect(launchFor("isolated", null, null)).toBe("fresh");
	});
});

describe("your own browser profile is disabled, never substituted (#1601 owner decision)", () => {
	it("is available with no engine and no agent default", () => {
		expect(ownProfileBlock(at({}))).toBeNull();
		expect(ownProfileBlock(at({ instanceProfile: "persistent" }))).toBeNull(); // choosing it clears this instance's own policy
	});
	it("is disabled, with the reason, while an engine is chosen on this instance", () => {
		expect(ownProfileBlock(at({ instanceEngine: "chrome" }))).toMatch(/cannot be used while a browser is chosen in Browser settings/);
	});
	it("is disabled, with the agent-default wording, while the agent's default engine or profile applies", () => {
		for (const over of [{ agentEngine: "msedge" as const }, { agentProfile: "persistent" as const }]) {
			expect(ownProfileBlock(at(over))).toMatch(/while this agent’s default browser or profile applies/);
		}
	});
	it("is never the shown choice while blocked, so no managed profile is passed off as the owner's", () => {
		for (const over of [{ instanceEngine: "chrome" as const }, { agentEngine: "chrome" as const }, { agentProfile: "ephemeral" as const }]) {
			const i = at({ browserProfile: "default", ...over });
			expect(ownProfileBlock(i)).not.toBeNull();
			expect(selectedChoice(i)).not.toBe("own");
		}
	});
});

describe("each choice writes the pair that launches what its label says", () => {
	const writes: Array<[ProfileChoice, LaunchProfile]> = [["fresh", "fresh"], ["kept", "kept"], ["own", "own"]];
	for (const [choice, launches] of writes) {
		it(`${choice}: round-trips to the launch it names, whatever else was set`, () => {
			const w = writesFor(choice);
			const saved = at({ browserProfile: w.browserProfile, instanceProfile: w.profile });
			expect(effectiveLaunch(saved)).toBe(launches);
			expect(selectedChoice(saved)).toBe(choice);
		});
	}
	it("fresh and kept keep the engine and the agent's defaults out of it", () => {
		for (const choice of ["fresh", "kept"] as const) {
			const w = writesFor(choice);
			expect(effectiveLaunch(at({ browserProfile: w.browserProfile, instanceProfile: w.profile, instanceEngine: "firefox", agentProfile: "ephemeral" }))).toBe(choice);
		}
	});
	it("the agent's default clears this instance's overrides and reads back as the default", () => {
		const w = writesFor("default");
		expect(w).toEqual({ browserProfile: "isolated", profile: null });
		expect(selectedChoice(at({ browserProfile: w.browserProfile, instanceProfile: w.profile }))).toBe("default");
	});
	it("choosing the agent's default launches what its label announced", () => {
		const before = at({ browserProfile: "default", instanceProfile: "persistent", instanceEngine: "chrome", agentProfile: "ephemeral" });
		const announced = defaultLaunch(before);
		const w = writesFor("default");
		expect(effectiveLaunch({ ...before, browserProfile: w.browserProfile, instanceProfile: w.profile })).toBe(announced);
	});
});
