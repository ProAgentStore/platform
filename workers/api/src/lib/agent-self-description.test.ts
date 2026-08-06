import { describe, expect, it } from "vitest";
import {
	executionAuthorityPrompt,
	repoMatchesSetting,
	resolveSelfModel,
	selfDescriptionPrompt,
	tabsFor,
} from "./agent-self-description.js";
import { CODER_LEAD, CODER_REPO, LEGACY_CODER, PLAIN_CHAT, REPO_CHAT } from "./first-party-agents.js";

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
