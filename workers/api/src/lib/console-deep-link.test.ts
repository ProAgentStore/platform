/**
 * get_console_link builds only links that land where they say (#938).
 *
 * Every link is held against the console's own route grammar (`checkConsoleLink`), and the section
 * table against the console's own tab list — so a renamed tab fails here, not in someone's chat.
 */
import { describe, expect, it } from "vitest";
import { checkConsoleLink, INSTANCE_TABS } from "../../../../store/console/src/lib/routes";
import { buildConsoleLink, CONSOLE_ORIGIN, CONSOLE_SECTIONS, type ConsoleLink, type ConsoleTarget, type LinkCaps } from "./console-deep-link";

const CODER: LinkCaps = { surfaces: ["coding"] };
const REPO_CHAT: LinkCaps = { surfaces: ["repo"], tools: ["search_knowledge", "list_knowledge", "read_knowledge"] };
const APPLY: LinkCaps = { surfaces: ["apply"] };

function ok(target: ConsoleTarget, caps: LinkCaps = CODER): ConsoleLink {
	const link = buildConsoleLink("inst_1", target, caps);
	if ("error" in link) throw new Error(link.error);
	const check = checkConsoleLink(link.path);
	expect(check.ok, `${link.path}: ${check.ok === false ? check.reason : ""}`).toBe(true);
	expect(link.url).toBe(`${CONSOLE_ORIGIN}${link.path}`);
	return link;
}

describe("the section table mirrors the console", () => {
	it("names exactly the console's instance tabs, in order", () => {
		expect(CONSOLE_SECTIONS.map((s) => s.id)).toEqual([...INSTANCE_TABS]);
	});
});

describe("buildConsoleLink", () => {
	it("links the instance itself to its Assistant tab", () => {
		expect(ok({ kind: "instance" }).path).toBe("/console/instances/inst_1");
	});

	it("links every section a coding agent shows, each to a real page", () => {
		const shown = CONSOLE_SECTIONS.filter((s) => s.shown(CODER)).map((s) => s.id);
		expect(shown).toEqual(expect.arrayContaining(["chat", "board", "coding", "knowledge", "settings", "indexing", "data"]));
		for (const id of shown) {
			const { path } = ok({ kind: "section", section: id });
			expect(path).toBe(id === "chat" ? "/console/instances/inst_1" : `/console/instances/inst_1/${id}`);
		}
	});

	it("builds the canonical Files uploader link only when the instance can read uploaded files", () => {
		const link = ok({ kind: "filesUpload" }, REPO_CHAT);
		expect(link.path).toBe("/console/instances/inst_1/knowledge?subtab=files");
		expect(link.url).toBe("https://proagentstore.online/console/instances/inst_1/knowledge?subtab=files");
		expect(link.url).not.toMatch(/token|session|credential/i);

		const denied = buildConsoleLink("inst_1", { kind: "filesUpload" }, { surfaces: [], tools: ["write_code"] });
		expect(denied).toEqual({
			error: "This instance cannot accept Files uploads because it does not declare file or knowledge-reading capability.",
			reason: "files_upload_unsupported",
		});
	});

	it("refuses an unknown section, naming the real ones", () => {
		const r = buildConsoleLink("inst_1", { kind: "section", section: "logs" }, CODER);
		expect("error" in r && r.error).toMatch(/"logs" is not a console section\. Sections: chat, apply, board/);
	});

	it("refuses a tab this instance does not show, instead of a link that lands elsewhere", () => {
		const coding = buildConsoleLink("inst_1", { kind: "section", section: "coding" }, REPO_CHAT);
		expect("error" in coding && coding.error).toMatch(/does not show the Coding tab \(it needs the coding surface\).*It shows: chat, repo,/);
		// The board is hidden on an apply agent (its own board) and on repo chat (no work to show).
		for (const caps of [APPLY, REPO_CHAT]) expect(buildConsoleLink("inst_1", { kind: "section", section: "board" }, caps)).toHaveProperty("error");
		// A declared allowlist without collection tools hides Data; no allowlist at all shows it.
		expect(buildConsoleLink("inst_1", { kind: "section", section: "data" }, REPO_CHAT)).toHaveProperty("error");
		ok({ kind: "section", section: "data" }, { surfaces: [] });
	});

	it("shows the Research tab only for a local browser agent (#946)", () => {
		expect(ok({ kind: "section", section: "research" }, { surfaces: [], runtime: "local_browser" }).path).toBe("/console/instances/inst_1/research");
		expect(buildConsoleLink("inst_1", { kind: "section", section: "research" }, CODER)).toHaveProperty("error");
		expect(ok({ kind: "local_browser_run", runId: "run 9" }).path).toBe("/console/instances/inst_1/research/run%209");
	});

	it("shows Index for repo chat by its surface, even with no write tools", () => {
		expect(ok({ kind: "section", section: "indexing" }, REPO_CHAT).path).toBe("/console/instances/inst_1/indexing");
	});

	it("links a coding run to the session it drives, and a chat run to the Assistant", () => {
		expect(ok({ kind: "run", runId: "r1", sessionId: "sess_9" }).path).toBe("/console/instances/inst_1/coding/sess_9");
		const chat = ok({ kind: "run", runId: "r1", sessionId: null });
		expect(chat.path).toBe("/console/instances/inst_1");
		expect(chat.lands).toMatch(/Autonomous runs/);
	});

	it("links a task to its record page and a secret request to its entry page", () => {
		expect(ok({ kind: "task", taskId: "t_7" }).path).toBe("/console/instances/inst_1/tasks/t_7");
		expect(ok({ kind: "secure_input", requestId: "sir_3" }).path).toBe("/console/instances/inst_1/secure-inputs/sir_3");
	});

	it("escapes ids so one cannot add path segments the console would drop", () => {
		const { path } = ok({ kind: "task", taskId: "a/b" });
		expect(path).toBe("/console/instances/inst_1/tasks/a%2Fb");
	});
});
