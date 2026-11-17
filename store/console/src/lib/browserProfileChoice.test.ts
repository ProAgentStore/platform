/**
 * The one browser-profile choice (#1601): every saved pair reads back as the launch it already produced (the table in the issue,
 * verified against `BrowserSessions.browserFor`), and every choice writes the pair that launches what its label says.
 *
 * The launch path and effective policy are the SERVER's (`launchPath`, `effective.profile` from #1603): each fixture states them
 * explicitly, as the server would answer, and none is derived from the engine here.
 */
import { describe, expect, it } from "vitest";
import {
	LAUNCH_LABELS, choiceLabel, defaultLaunch, effectiveLaunch, hasProfileFields, launchFor, ownProfileBlock, selectedChoice, writesFor,
	type LaunchProfile, type ProfileChoice, type ProfileInputs,
} from "./browserProfileChoice";

const base: ProfileInputs = { browserProfile: "isolated", launchPath: "legacy", effectiveProfile: null, instanceEngine: null, instanceProfile: null, agentEngine: null, agentProfile: null };
const at = (over: Partial<ProfileInputs>): ProfileInputs => ({ ...base, ...over });

/** Each saved row of the issue's table: what is stored, what the server says, what it launches today, and the choice the control shows. */
const ROWS: Array<{ row: string; inputs: ProfileInputs; launches: LaunchProfile; shows: ProfileChoice }> = [
	{ row: "1 isolated + ephemeral", inputs: at({ launchPath: "managed", effectiveProfile: "ephemeral", instanceProfile: "ephemeral" }), launches: "fresh", shows: "fresh" },
	{ row: "2 isolated + persistent", inputs: at({ launchPath: "managed", effectiveProfile: "persistent", instanceProfile: "persistent" }), launches: "kept", shows: "kept" },
	{ row: "3 isolated + not set, no engine (legacy)", inputs: at({}), launches: "fresh", shows: "default" },
	{ row: "4 default + ephemeral", inputs: at({ browserProfile: "default", launchPath: "managed", effectiveProfile: "ephemeral", instanceProfile: "ephemeral" }), launches: "fresh", shows: "fresh" },
	{ row: "5 default + persistent", inputs: at({ browserProfile: "default", launchPath: "managed", effectiveProfile: "persistent", instanceProfile: "persistent" }), launches: "kept", shows: "kept" },
	{ row: "6 default + not set, no engine (legacy)", inputs: at({ browserProfile: "default" }), launches: "own", shows: "own" },
	{ row: "6b default + not set, engine set (managed, derived persistent)", inputs: at({ browserProfile: "default", launchPath: "managed", instanceEngine: "chrome" }), launches: "kept", shows: "kept" },
];

describe("what the saved settings launch today is what the control shows (#1601)", () => {
	for (const { row, inputs, launches, shows } of ROWS) {
		it(`row ${row}: launches ${launches}, shows ${shows}`, () => {
			expect(effectiveLaunch(inputs)).toBe(launches);
			expect(selectedChoice(inputs)).toBe(shows);
		});
	}

	it("an engine alone (isolated, profile unset) is managed and derives an ephemeral profile: fresh, shown as the agent's default", () => {
		const i = at({ launchPath: "managed", instanceEngine: "firefox" });
		expect(effectiveLaunch(i)).toBe("fresh");
		expect(selectedChoice(i)).toBe("default");
	});

	it("the agent's own policy counts through the server's effective value, and nothing set here reads as its default", () => {
		const i = at({ launchPath: "managed", effectiveProfile: "persistent", agentProfile: "persistent" });
		expect(effectiveLaunch(i)).toBe("kept");
		expect(selectedChoice(i)).toBe("default");
		expect(choiceLabel("default", i)).toBe(`Use the agent’s default (now: ${LAUNCH_LABELS.kept})`);
	});

	it("the two stores disagree: the control shows what takes effect at launch", () => {
		// browserProfile says own, but a profile policy is in force: the managed path never uses the owner's profile.
		expect(selectedChoice(at({ browserProfile: "default", launchPath: "managed", effectiveProfile: "ephemeral", instanceProfile: "ephemeral" }))).toBe("fresh");
		// the instance's own policy wins over the agent's default (the server's effective value is the instance's).
		expect(selectedChoice(at({ launchPath: "managed", effectiveProfile: "ephemeral", instanceProfile: "ephemeral", agentProfile: "persistent" }))).toBe("fresh");
	});

	it("the SERVER's launch path is trusted over any local reading of the engine (mismatch fixtures)", () => {
		// Server says legacy although an engine is recorded (a runner-side default the console cannot see): own profile is reachable.
		expect(effectiveLaunch(at({ browserProfile: "default", launchPath: "legacy", instanceEngine: "chrome" }))).toBe("own");
		// Server says managed although nothing the console can see sets an engine or policy: the owner's profile is NOT used.
		expect(effectiveLaunch(at({ browserProfile: "default", launchPath: "managed" }))).toBe("kept");
		expect(selectedChoice(at({ browserProfile: "default", launchPath: "managed" }))).toBe("kept");
	});

	it("the mapping is the runner's: policy first, then the managed-path derived policy, then the legacy path", () => {
		expect(launchFor("default", "managed", "ephemeral")).toBe("fresh");
		expect(launchFor("isolated", "managed", "persistent")).toBe("kept");
		expect(launchFor("default", "managed", null)).toBe("kept");
		expect(launchFor("isolated", "managed", null)).toBe("fresh");
		expect(launchFor("default", "legacy", null)).toBe("own");
		expect(launchFor("isolated", "legacy", null)).toBe("fresh");
	});
});

describe("your own browser profile is disabled, never substituted (#1601 owner decision)", () => {
	it("is available on the legacy path", () => {
		expect(ownProfileBlock(at({}))).toBeNull();
	});
	it("is available when only this instance's own policy makes the path managed: choosing it clears that policy", () => {
		expect(ownProfileBlock(at({ launchPath: "managed", effectiveProfile: "persistent", instanceProfile: "persistent" }))).toBeNull();
	});
	it("is disabled, with the reason, while an engine is chosen on this instance", () => {
		expect(ownProfileBlock(at({ launchPath: "managed", instanceEngine: "chrome" }))).toMatch(/cannot be used while a browser is chosen in Browser settings/);
		// An engine AND a policy of its own: clearing the policy still leaves the engine.
		expect(ownProfileBlock(at({ launchPath: "managed", instanceEngine: "chrome", effectiveProfile: "persistent", instanceProfile: "persistent" }))).toMatch(/browser is chosen/);
	});
	it("is disabled, with the agent-default wording, while the agent's default engine or profile applies", () => {
		for (const over of [{ agentEngine: "msedge" as const }, { agentProfile: "persistent" as const, effectiveProfile: "persistent" as const }]) {
			expect(ownProfileBlock(at({ launchPath: "managed", ...over }))).toMatch(/while this agent’s default browser or profile applies/);
		}
	});
	it("follows the server: managed with no cause the console can see is still disabled, never offered", () => {
		expect(ownProfileBlock(at({ launchPath: "managed" }))).toMatch(/this agent’s default/);
	});
	it("is never the shown choice while blocked, so no managed profile is passed off as the owner's", () => {
		for (const over of [{ instanceEngine: "chrome" as const }, { agentEngine: "chrome" as const }, { effectiveProfile: "ephemeral" as const, agentProfile: "ephemeral" as const }, {}]) {
			const i = at({ browserProfile: "default", launchPath: "managed", ...over });
			expect(ownProfileBlock(i)).not.toBeNull();
			expect(selectedChoice(i)).not.toBe("own");
		}
	});
});

describe("each choice writes the pair that launches what its label says", () => {
	/** What the server answers once the pair is saved with nothing else in force. */
	const saved = (choice: ProfileChoice, extra: Partial<ProfileInputs> = {}): ProfileInputs => {
		const w = writesFor(choice);
		const effectiveProfile = w.profile ?? extra.agentProfile ?? null;
		const managed = !!(effectiveProfile || extra.instanceEngine || extra.agentEngine);
		return at({ browserProfile: w.browserProfile, instanceProfile: w.profile, effectiveProfile, launchPath: managed ? "managed" : "legacy", ...extra });
	};
	const writes: Array<[ProfileChoice, LaunchProfile]> = [["fresh", "fresh"], ["kept", "kept"], ["own", "own"]];
	for (const [choice, launches] of writes) {
		it(`${choice}: round-trips to the launch it names`, () => {
			expect(effectiveLaunch(saved(choice))).toBe(launches);
			expect(selectedChoice(saved(choice))).toBe(choice);
		});
	}
	it("fresh and kept keep the engine and the agent's defaults out of it", () => {
		for (const choice of ["fresh", "kept"] as const) {
			expect(effectiveLaunch(saved(choice, { instanceEngine: "firefox", agentProfile: "ephemeral" }))).toBe(choice);
		}
	});
	it("the agent's default clears this instance's overrides and reads back as the default", () => {
		expect(writesFor("default")).toEqual({ browserProfile: "isolated", profile: null });
		expect(selectedChoice(saved("default"))).toBe("default");
	});
	it("choosing the agent's default launches what its label announced, whatever path it lands on", () => {
		for (const extra of [{}, { agentProfile: "persistent" as const }, { agentProfile: "ephemeral" as const }, { instanceEngine: "chrome" as const }]) {
			const before = at({ browserProfile: "default", launchPath: "managed", effectiveProfile: "persistent", instanceProfile: "persistent", ...extra });
			expect(effectiveLaunch(saved("default", extra))).toBe(defaultLaunch(before));
		}
	});
});

describe("a browser-settings answer without what the choice reads is refused, not rendered (#1601)", () => {
	const f = { engine: null, profile: null };
	const ok = { ...f, agentDefaults: f, effective: f, launchPath: "legacy" };
	it("accepts a full answer, including all-null fields and either path", () => {
		expect(hasProfileFields(ok)).toBe(true);
		expect(hasProfileFields({ ...ok, launchPath: "managed", engine: "chrome", effective: { engine: "chrome", profile: "persistent" }, agentDefaults: { engine: "firefox", profile: "persistent" } })).toBe(true);
	});
	it("refuses an empty body, null, a non-object, and a body missing the defaults, the effective values or the path", () => {
		for (const bad of [{}, null, undefined, "x", 3, { ...f }, { ...ok, agentDefaults: null }, { ...ok, agentDefaults: {} }, { ...ok, effective: undefined }, { ...ok, effective: {} }]) expect(hasProfileFields(bad)).toBe(false);
	});
	it("refuses an unknown or missing launch path rather than guessing the launch", () => {
		for (const launchPath of [undefined, null, "", "hybrid", 1]) expect(hasProfileFields({ ...ok, launchPath })).toBe(false);
	});
});
