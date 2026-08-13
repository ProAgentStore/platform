import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	AGENT_PAGE_TABS,
	chatSurfaceForDoKey,
	executionAuthorityPrompt,
	repoMatchesSetting,
	resolveSelfModel,
	selfDescriptionPrompt,
	tabsFor,
	tabsForSurface,
	TRIAL_DO_PREFIX,
} from "./agent-self-description.js";
import { CODER_LEAD, CODER_REPO, FIRST_PARTY_AGENTS, LEGACY_CODER, PLAIN_CHAT, REPO_CHAT } from "./first-party-agents.js";

/**
 * The five agents these assertions are about now live in `lib/first-party-agents.ts` (#315), shared
 * with the prompt-drift guard. Two copies of "what a Repo Coder is" is the drift this repo keeps
 * paying for: the copy nobody updates goes on passing.
 */

describe("resolveSelfModel — what the agent may say it is", () => {
	it("a Repo Coder has an executor but may not drive the engine from chat", () => {
		const m = resolveSelfModel(CODER_REPO);
		expect(m.canStartWork).toBe(true);
		expect(m.canDrive).toBe(false);
		expect(m.singleRepo).toBe(true);
		expect(m.hasCodeIndex).toBe(false);
	});

	it("the legacy Coder drives its own engine and owns many repos", () => {
		const m = resolveSelfModel(LEGACY_CODER);
		expect(m.canDrive).toBe(true);
		expect(m.canStartWork).toBe(true);
		expect(m.singleRepo).toBe(false);
	});

	it("Repo Chat has a code index and no executor", () => {
		const m = resolveSelfModel(REPO_CHAT);
		expect(m.hasCodeIndex).toBe(true);
		expect(m.canStartWork).toBe(false);
		expect(m.canDrive).toBe(false);
	});

	it("an agent whose only executor is this same chat does NOT claim one", () => {
		// `start_work` is in BASE so every agent HAS the tool, but its handler refuses when the
		// resolved driver is the default chat loop ("recursion dressed as delegation"). Claiming an
		// executor here would be the story-the-tools-contradict failure the module exists to stop.
		expect(resolveSelfModel(PLAIN_CHAT).canStartWork).toBe(false);
		expect(resolveSelfModel(CODER_LEAD).canStartWork).toBe(false);
	});
});

describe("tabsFor — an agent may only name tabs it actually has", () => {
	it("a Repo Coder has a Coding tab and NO Repo tab", () => {
		// The exact production failure: it told a user to "attach a repository in the Repo tab".
		const tabs = tabsFor(CODER_REPO);
		expect(tabs).toContain("Coding");
		expect(tabs).not.toContain("Repo");
	});

	it("Repo Chat has a Repo tab and no Coding tab", () => {
		const tabs = tabsFor(REPO_CHAT);
		expect(tabs).toContain("Repo");
		expect(tabs).not.toContain("Coding");
		// repo-chat is read-only chat over an indexed codebase — no work board.
		expect(tabs).not.toContain("Board");
	});

	it("a declared allowlist without collection tools hides the Data tab", () => {
		expect(tabsFor(CODER_REPO)).not.toContain("Data");
		// Undeclared is permissive: the server hands it the per-surface default, so the console
		// cannot narrow the tab set from a declaration that does not exist.
		expect(tabsFor(PLAIN_CHAT)).toContain("Data");
	});

	it("every agent has the universal tabs", () => {
		for (const caps of [CODER_REPO, LEGACY_CODER, REPO_CHAT, CODER_LEAD, PLAIN_CHAT]) {
			expect(tabsFor(caps)).toEqual(expect.arrayContaining(["Assistant", "Knowledge", "Settings", "Behaviour", "Activity"]));
		}
	});
});

describe("executionAuthorityPrompt — #254, the prompt must not forbid what start_work does", () => {
	it("an agent WITH an executor is told its work is real, and told not to retract it", () => {
		const p = executionAuthorityPrompt(resolveSelfModel(CODER_REPO));
		expect(p).toContain("start_work");
		expect(p).toMatch(/really does drive/);
		expect(p).toContain("check_work");
		expect(p).toMatch(/[Nn]ever retract/);
		// The line that caused the denial must be gone: it said, as a NEVER, that from this chat
		// the agent does not drive the engine or run shell commands.
		expect(p).not.toMatch(/you do not drive the engine/i);
		// It still must not claim it typed the command itself.
		expect(p).toMatch(/[Nn]ever say that YOU personally ran a command/);
	});

	it("an agent with BOTH is told about both, not just the first branch", () => {
		// The legacy Coder has an executor AND the drive tools. An if/else chain described half of
		// its reach — the same class of error as describing none of it.
		const p = executionAuthorityPrompt(resolveSelfModel(LEGACY_CODER));
		expect(p).toContain("send_to_cli");
		expect(p).toContain("start_work");
	});

	it("a chat that may not drive is never told it can send to the engine", () => {
		// `drive:false` is deliberate — a chat driving the CLI would be a second uncoordinated
		// driver (#154). #256 restores the ability to LOOK, never the ability to steer.
		expect(executionAuthorityPrompt(resolveSelfModel(CODER_REPO))).not.toContain("send_to_cli");
	});

	it("a Lead is told delegating IS acting, and that its runs live on its subordinates (#318)", () => {
		// It had no executor and no drive tools, so it fell into "you cannot run shell commands…
		// never claim you fixed a bug" — false for the only thing it exists to do. Combined with a
		// check_work that found nothing on its own instance, that is what made it retract a true
		// delegation report.
		const p = executionAuthorityPrompt(resolveSelfModel(CODER_LEAD));
		expect(resolveSelfModel(CODER_LEAD).canDelegate).toBe(true);
		expect(p).not.toMatch(/cannot run shell commands/);
		expect(p).toContain("delegate_goal");
		expect(p).toMatch(/never on you/i);
	});

	it("an agent with NEITHER still gets the strict version", () => {
		// The verification #254 asks for: an agent that genuinely cannot act must still refuse.
		const p = executionAuthorityPrompt(resolveSelfModel(REPO_CHAT));
		expect(p).toMatch(/cannot run shell commands/);
		expect(p).not.toContain("start_work");
	});
});

describe("selfDescriptionPrompt — #255, ownership is a fact, not a memory string", () => {
	it("a single-repo agent is told which ONE repository it owns", () => {
		const p = selfDescriptionPrompt(resolveSelfModel(CODER_REPO), {
			repoSetting: "~/dev/stores/fas/platform",
			attached: [{ name: "platform", githubRepo: "freeappstore-online/platform", workdir: "~/dev/stores/fas/platform" }],
		});
		expect(p).toMatch(/exactly ONE repository/);
		expect(p).toContain("freeappstore-online/platform");
		expect(p).toMatch(/cannot add one/);
	});

	it("with no repo attached it says so and names ITS OWN place to set one", () => {
		const p = selfDescriptionPrompt(resolveSelfModel(CODER_REPO), { repoSetting: "", attached: [] });
		expect(p).toMatch(/not set yet/);
		expect(p).toContain("Settings");
		// Never the Repo tab — it does not have one.
		expect(p).not.toMatch(/Repo tab/);
	});

	it("forbids naming any tab the agent does not have", () => {
		const p = selfDescriptionPrompt(resolveSelfModel(CODER_REPO), { attached: [] });
		expect(p).toContain("Coding");
		expect(p).toMatch(/NEVER refer the user to any other tab/);
		expect(p).not.toMatch(/\bRepo,/);
	});

	it("flags a setting that disagrees with the attached repo instead of guessing", () => {
		const p = selfDescriptionPrompt(resolveSelfModel(CODER_REPO), {
			repoSetting: "~/dev/other-repo",
			attached: [{ name: "platform", githubRepo: "org/platform" }],
		});
		expect(p).toMatch(/the `repo` setting says/);
	});

	it("says nothing about ownership for a multi-repo agent", () => {
		const p = selfDescriptionPrompt(resolveSelfModel(LEGACY_CODER), { attached: [{ name: "a" }, { name: "b" }] });
		expect(p).not.toMatch(/exactly ONE repository/);
	});

	it("mentions extra repos rather than silently working on the first", () => {
		const p = selfDescriptionPrompt(resolveSelfModel(CODER_REPO), {
			attached: [{ name: "a" }, { name: "b" }],
		});
		expect(p).toMatch(/2 repositories are attached/);
	});
});

// ── #519: which console the prompt is allowed to describe ────────────────────────────────────

const ROOT = new URL("../../../../", import.meta.url).pathname;
const AGENT_PAGE = "store/console/src/pages/AgentDetail.tsx";
const TRIAL_ROUTE = "workers/api/src/routes/public.ts";

/**
 * The tabs `AgentDetail.tsx` really renders, read from the page itself.
 *
 * The binding acceptance criterion 3 asks for, and the reason it is a parse rather than a second
 * hand-typed list: `tabsFor` drifted from `surfaces.tsx` for long enough to ship an agent prompt
 * missing the Stats tab, and nothing could report it. ADR 0002 G1/G3 — a parse that finds nothing
 * THROWS rather than returning an empty list that would pass every comparison below.
 *
 * What this parser does NOT handle, stated rather than discovered: a tab whose label is not a
 * double-quoted literal inside the `allTabs` array (a computed label, a template string, a `?:`).
 * The count assertions below are what catch that — a label the regex cannot see makes the two
 * lists differ in LENGTH, which fails.
 */
function consoleAgentPageTabs(): { labels: string[]; ids: string[]; source: string } {
	const source = readFileSync(join(ROOT, AGENT_PAGE), "utf8");
	const block = source.match(/const allTabs:[^=]*=\s*\[([\s\S]*?)\];/);
	if (!block) {
		throw new Error(
			`${AGENT_PAGE}: no \`const allTabs: … = [ … ];\` array found. The console's tab list has moved or changed shape,` +
				" so this guard is measuring nothing — find the new list and re-point the parser. Do not delete this test:" +
				" the prompt it protects tells the model its tab list is EXHAUSTIVE (#519).",
		);
	}
	return {
		labels: [...block[1].matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]),
		ids: [...block[1].matchAll(/id:\s*"([^"]+)"/g)].map((m) => m[1]),
		source,
	};
}

describe("the agent-template surface describes the page the reader is on (#519)", () => {
	const page = consoleAgentPageTabs();

	it("read a tab list of a plausible size, and every entry of it", () => {
		// G1 + G3: the denominator is asserted, not assumed. A partial parse — five of seven
		// entries — would otherwise silently narrow every comparison in this file.
		expect(page.labels.length, `${AGENT_PAGE}: parsed ${page.labels.length} tab labels; fewer than 5 means the array moved`).toBeGreaterThanOrEqual(5);
		expect(page.ids.length, `${AGENT_PAGE}: ${page.ids.length} tab ids vs ${page.labels.length} labels — the parse dropped an entry`).toBe(page.labels.length);
	});

	it("is bound to the console router, so the two cannot drift", () => {
		expect(
			AGENT_PAGE_TABS,
			`AGENT_PAGE_TABS no longer matches ${AGENT_PAGE}. The prompt tells the model this list is exhaustive and\n` +
				"forbids naming anything outside it, so a stale copy sends a creator to a tab that is not there — which is\n" +
				"the whole of #519. Update AGENT_PAGE_TABS to the list the page renders.",
		).toEqual(page.labels);
	});

	it("the page renders that literal unconditionally — which is what makes a closed NEVER honest", () => {
		// Unlike `tabsFor`, this list has no predicates: no `show()`, no filter, no capability gate.
		// The NEVER is only safe while that holds, so it is checked rather than assumed.
		expect(page.source).toMatch(/\{allTabs\.map\(/);
		expect(page.source, `${AGENT_PAGE} now filters its tab list, so AGENT_PAGE_TABS is a superset and the NEVER over-claims`).not.toMatch(/allTabs\s*\.\s*filter/);
	});

	it("names the agent page's tabs, not the subscriber console's", () => {
		// The issue's own example: a tmux Operator previewed from its template was told its console
		// had Assistant · Board · Terminal · Activity · Stats · Knowledge · Behaviour · Settings.
		const tmuxOperator = { surfaces: ["tmux" as const], runtime: null, workflow: null, boardColumns: [] };
		const p = selfDescriptionPrompt(resolveSelfModel(tmuxOperator, "agent-template"));
		for (const tab of AGENT_PAGE_TABS) expect(p).toContain(tab);
		const instanceOnly = tabsFor(tmuxOperator).filter((t) => !AGENT_PAGE_TABS.includes(t));
		expect(instanceOnly, "the fixture stopped exercising the mismatch this test is about").not.toEqual([]);
		for (const tab of instanceOnly) expect(p, `named "${tab}", which does not exist on ${AGENT_PAGE}`).not.toContain(tab);
	});

	it("gives every consumer of SelfModel.tabs the same answer, not just this prompt", () => {
		// `tabClause` in agent-style-prompt.ts gates on `model.tabs` too: a Coder previewed from its
		// template was pointed at a Coding tab the agent page does not have. Resolving the surface
		// into the model fixes both call sites at once.
		expect(resolveSelfModel(CODER_REPO, "agent-template").tabs).not.toContain("Coding");
		expect(resolveSelfModel(CODER_REPO, "instance").tabs).toContain("Coding");
	});

	it("says a subscribed instance has a different console rather than describing it", () => {
		const p = selfDescriptionPrompt(resolveSelfModel(PLAIN_CHAT, "agent-template"));
		expect(p).toMatch(/agent TEMPLATE here, not a subscribed instance/);
		expect(p).toMatch(/NEVER refer the user to any other tab/);
	});
});

describe("the public trial has no console to describe (#519)", () => {
	it("is the surface a trial DO key resolves to, and that key is the one the route mints", () => {
		const source = readFileSync(join(ROOT, TRIAL_ROUTE), "utf8");
		// G1: the route this claim is about must still be here, or the prefix below proves nothing.
		expect(source, `${TRIAL_ROUTE} no longer serves /agents/:id/try`).toContain('publicRoutes.post("/agents/:id/try"');
		const minted = source.match(/const doKey = `([^`$]+)\$\{agent\.id\}/);
		expect(minted?.[1], `${TRIAL_ROUTE}: could not read the trial DO key prefix — the guard is measuring nothing`).toBeTruthy();
		expect(minted?.[1]).toBe(TRIAL_DO_PREFIX);
		expect(chatSurfaceForDoKey(`${TRIAL_DO_PREFIX}agent-123:abcdef`)).toBe("trial");
	});

	it("names no tab at all, and points at subscribing instead", () => {
		const p = selfDescriptionPrompt(resolveSelfModel(PLAIN_CHAT, "trial"));
		expect(tabsForSurface("trial", PLAIN_CHAT)).toEqual([]);
		for (const tab of [...tabsFor(PLAIN_CHAT), ...AGENT_PAGE_TABS]) {
			// "Chat" and "Knowledge" are ordinary words as well as tab names; the claim being tested
			// is that no tab is NAMED as a place, which the sentence-level assertions below cover.
			if (["Chat", "Knowledge", "Settings"].includes(tab)) continue;
			expect(p, `a trial page has no console, but the prompt names "${tab}"`).not.toContain(tab);
		}
		expect(p).toMatch(/TRIAL chat on a public page/);
		expect(p).toMatch(/after they subscribe/);
	});

	it("an id that matches nothing and is not a trial says nothing about any console", () => {
		// The D1-failure path lands here. Claiming the smallest surface would tell a real subscriber,
		// mid-outage, that their console does not exist.
		expect(chatSurfaceForDoKey("inst_abc123")).toBe("unknown");
		expect(selfDescriptionPrompt(resolveSelfModel(PLAIN_CHAT, "unknown"))).toBe("");
		expect(tabsForSurface("unknown", CODER_REPO)).toEqual([]);
	});
});

describe("the subscribed-instance prompt is unchanged, byte for byte (#519 criterion 2)", () => {
	it("is the exact string that shipped", () => {
		// A full-string assertion, not a set of `toContain`s: the requirement is byte-identity, and
		// every `toContain` in this file would still pass if a comma or a clause moved.
		expect(
			selfDescriptionPrompt(resolveSelfModel(CODER_REPO), {
				repoSetting: "~/dev/stores/fas/platform",
				attached: [{ name: "platform", githubRepo: "freeappstore-online/platform", workdir: "~/dev/stores/fas/platform" }],
			}),
		).toBe(
			"\n\n## What you are\n" +
				"- You are responsible for exactly ONE repository: platform (freeappstore-online/platform) at ~/dev/stores/fas/platform." +
				" You do not manage any other repository and cannot add one.\n" +
				"- Your console has exactly these tabs: Assistant, Board, Coding, Activity, Stats, Knowledge, Behaviour, Settings." +
				" NEVER refer the user to any other tab — if a tab is not in that list, it does not exist for you, and sending" +
				" them there is a wrong answer.",
		);
	});

	it("is what an unspecified surface still produces, for every first-party agent", () => {
		// The default argument is the whole compatibility story: every existing caller passes no
		// surface. Reference-equality is not available across two calls, so this compares the whole
		// string for each agent, with and without the explicit surface.
		for (const { name, capabilities } of FIRST_PARTY_AGENTS) {
			const ctx = { repoSetting: "", attached: [{ name: "platform", githubRepo: "org/platform" }] };
			expect(selfDescriptionPrompt(resolveSelfModel(capabilities), ctx), name).toBe(
				selfDescriptionPrompt(resolveSelfModel(capabilities, "instance"), ctx),
			);
		}
	});
});

describe("repoMatchesSetting — loose on purpose", () => {
	it("matches a local path against a repo name", () => {
		expect(repoMatchesSetting({ name: "platform", workdir: "~/dev/stores/fas/platform" }, "~/dev/stores/fas/platform")).toBe(true);
		expect(repoMatchesSetting({ name: "platform" }, "platform")).toBe(true);
	});

	it("matches owner/name against the github repo, ignoring .git and case", () => {
		expect(repoMatchesSetting({ name: "x", githubRepo: "Org/Platform" }, "org/platform.git")).toBe(true);
	});

	it("matches on the trailing segment, so ~/dev/foo === owner/foo", () => {
		expect(repoMatchesSetting({ name: "foo", githubRepo: "org/foo" }, "~/dev/foo")).toBe(true);
	});

	it("does not match a genuinely different repo", () => {
		expect(repoMatchesSetting({ name: "platform", githubRepo: "org/platform" }, "~/dev/other-repo")).toBe(false);
	});

	it("an empty setting matches anything — nothing to disagree with", () => {
		expect(repoMatchesSetting({ name: "platform" }, "")).toBe(true);
	});
});
