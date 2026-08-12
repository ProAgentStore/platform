/**
 * The two production failures this module exists for (#494, #493) are the first two tests, written
 * as the turn that actually happened rather than as unit cases: an anonymous `fetch_url` to a
 * private repo returns 404, and the model must not be able to read that as "the name is wrong" or
 * as "someone needs to grant access".
 */
import { describe, expect, it } from "vitest";
import { GITHUB_CONNECTOR } from "./connectors/github.js";
import { annotateFetchResult, fetchUrlDiagnosis } from "./fetch-url-diagnosis.js";

/** The Operator in both incidents: seven tmux tools, no GitHub tool at any scope. */
const OPERATOR = new Set([
	"tmux_list_sessions",
	"tmux_capture_pane",
	"tmux_run_command",
	"tmux_send_keys",
	"tmux_send_message",
	"tmux_new_session",
	"tmux_kill_session",
	"fetch_url",
]);

/** A Repo Coder: the same fetch, but with a credentialed route it should be sent to instead. */
const CODER = new Set(["github_list_issues", "github_read_issue", "github_workflow_runs", "fetch_url"]);

describe("the incident that produced this module (#494)", () => {
	const note = fetchUrlDiagnosis({
		url: "https://github.com/heartfull-online/platform",
		status: 404,
		toolNames: OPERATOR,
		configuredRepo: "heartfull-online/platform",
	});

	it("says the request was anonymous, which is the fact the model could not know", () => {
		expect(note).toContain("no credential");
		expect(note).toMatch(/ANONYMOUSLY/);
	});

	it("removes the inference the 404 invited — that the name is wrong", () => {
		// The whole defect: the agent asked the owner to "confirm the exact organisation and
		// repository name". A 404 to an anonymous caller is GitHub declining to disclose
		// existence, and until the platform said so the model had no way to know that.
		expect(note).toContain("does not disclose");
		expect(note).toContain("NOT evidence that the repository, organisation or name is wrong");
		expect(note).toContain("Do not ask anyone to confirm the repository, organisation or name");
	});

	it("names the configured repo as authoritative, because this URL is that repo", () => {
		expect(note).toContain("`heartfull-online/platform`");
		expect(note).toContain("authoritative");
		expect(note).toContain("does not contradict it");
	});
});

describe("the residual that survived the first fix (#493)", () => {
	it("forbids the false remedy AND states the true one: the gap is a tool, not a credential", () => {
		const note = fetchUrlDiagnosis({
			url: "https://github.com/heartfull-online/platform/issues",
			status: 404,
			toolNames: OPERATOR,
		});
		// "ask someone to grant this agent access" was factually wrong: the platform held a working
		// installation token for that repo (hosted-repo.ts returns available:false without one, and
		// the recorded probe returned available:true). Nothing needed granting.
		expect(note).toContain("not a credential that is missing");
		expect(note).toContain("not a permission anyone can grant");
		expect(note).toContain("do not ask anyone to grant access");
		expect(note).toContain("no access to request");
	});

	it("says a subscriber cannot add the tool, matching how toolNamesFor actually resolves", () => {
		const note = fetchUrlDiagnosis({ url: "https://github.com/x/y", status: 404, toolNames: OPERATOR });
		expect(note).toContain("fixed by this agent's definition");
		expect(note).toContain("switch a tool OFF but cannot add one");
	});
});

describe("the branch that keeps the note honest", () => {
	it("does NOT tell an agent that holds GitHub tools it has no way to reach GitHub", () => {
		// #493 was filed because the platform stayed silent about an absent capability. Asserting an
		// absence that is false would be the same defect pointed the other way.
		const note = fetchUrlDiagnosis({ url: "https://api.github.com/repos/x/y", status: 404, toolNames: CODER });
		expect(note).toContain("You DO have dedicated GitHub tools");
		expect(note).toContain("github_list_issues");
		expect(note).not.toContain("You have NO dedicated");
		expect(note).toContain("Call one of those instead");
	});

	it("lists the agent's own GitHub tools, sorted, and no others", () => {
		const note = fetchUrlDiagnosis({ url: "https://github.com/x/y", status: 404, toolNames: CODER });
		expect(note).toContain("github_list_issues, github_read_issue, github_workflow_runs");
		expect(note).not.toContain("github_create_issue");
	});
});

describe("scope — the platform only speaks where it knows more than the model", () => {
	it("says nothing on success", () => {
		expect(fetchUrlDiagnosis({ url: "https://github.com/x/y", status: 200, toolNames: OPERATOR })).toBe("");
	});

	it("says nothing on a 5xx, whose obvious reading is the correct one", () => {
		expect(fetchUrlDiagnosis({ url: "https://github.com/x/y", status: 500, toolNames: OPERATOR })).toBe("");
		expect(fetchUrlDiagnosis({ url: "https://github.com/x/y", status: 502, toolNames: OPERATOR })).toBe("");
	});

	it("says nothing about a host the platform has no dedicated connector for", () => {
		expect(fetchUrlDiagnosis({ url: "https://example.com/anything", status: 404, toolNames: OPERATOR })).toBe("");
		expect(fetchUrlDiagnosis({ url: "https://gitlab.com/x/y", status: 404, toolNames: OPERATOR })).toBe("");
	});

	it("covers GitHub's other hostnames, since they are the same host to a caller", () => {
		for (const u of [
			"https://api.github.com/repos/x/y/issues",
			"https://raw.githubusercontent.com/x/y/main/README.md",
			"https://gist.github.com/x/y",
		])
			expect(fetchUrlDiagnosis({ url: u, status: 404, toolNames: OPERATOR })).not.toBe("");
	});

	it("is not fooled by a lookalike host", () => {
		expect(fetchUrlDiagnosis({ url: "https://github.com.evil.example/x", status: 404, toolNames: OPERATOR })).toBe("");
		expect(fetchUrlDiagnosis({ url: "https://notgithub.com/x", status: 404, toolNames: OPERATOR })).toBe("");
	});

	it("survives a malformed or non-string url without throwing", () => {
		expect(fetchUrlDiagnosis({ url: "not a url", status: 404 })).toBe("");
		expect(fetchUrlDiagnosis({ url: undefined, status: 404 })).toBe("");
		expect(fetchUrlDiagnosis({ url: 42, status: 404 })).toBe("");
	});
});

describe("the status clauses are per-status facts, not one message with a number in it", () => {
	it("403 is about the anonymous rate limit, not about existence", () => {
		const note = fetchUrlDiagnosis({ url: "https://api.github.com/repos/x/y", status: 403, toolNames: OPERATOR });
		expect(note).toContain("60 per hour");
		expect(note).not.toContain("does not disclose");
	});

	it("401 is a credential never sent, not one rejected", () => {
		const note = fetchUrlDiagnosis({ url: "https://api.github.com/repos/x/y", status: 401, toolNames: OPERATOR });
		expect(note).toContain("no credential was presented");
		expect(note).toContain("not because a credential was rejected");
	});

	it("every clause refuses to let the status be read as evidence about the name", () => {
		for (const status of [401, 403, 404]) {
			const note = fetchUrlDiagnosis({ url: "https://github.com/x/y", status, toolNames: OPERATOR });
			expect(note).toMatch(/says nothing about|NOT evidence/);
		}
	});
});

describe("the configured-repo clause", () => {
	it("stays silent when the URL is some unrelated repo", () => {
		// Asserting "the configured repo is authoritative" against an unrelated URL would read as
		// confirmation that the unrelated URL WAS the configured repo — a worse error than silence.
		const note = fetchUrlDiagnosis({
			url: "https://github.com/someone-else/other",
			status: 404,
			toolNames: OPERATOR,
			configuredRepo: "heartfull-online/platform",
		});
		expect(note).not.toContain("authoritative");
		expect(note).not.toContain("heartfull-online/platform");
	});

	it("matches case-insensitively, because GitHub owners are", () => {
		// The incident's repo is stored `heartfull-online/platform` and rendered on GitHub as
		// `HeartFull-online/platform`; a case-sensitive check would have missed the live case.
		const note = fetchUrlDiagnosis({
			url: "https://github.com/HeartFull-online/platform",
			status: 404,
			toolNames: OPERATOR,
			configuredRepo: "heartfull-online/platform",
		});
		expect(note).toContain("authoritative");
	});

	it("ignores a malformed configured value, using the Deployment block's own guard", () => {
		for (const repo of ["", "no-slash", null, 7, { a: 1 }]) {
			const note = fetchUrlDiagnosis({
				url: "https://github.com/x/y",
				status: 404,
				toolNames: OPERATOR,
				configuredRepo: repo,
			});
			expect(note).not.toContain("authoritative");
		}
	});
});

describe("annotateFetchResult", () => {
	it("appends to fetch_url and leaves every other tool alone", () => {
		const base = { name: "tmux_capture_pane", content: "HTTP 404", success: false };
		expect(annotateFetchResult(base, { url: "https://github.com/x/y", status: 404, toolNames: OPERATOR })).toBe(base);
	});

	it("returns the result unchanged when there is nothing to say", () => {
		const base = { name: "fetch_url", content: "ok", success: true };
		expect(annotateFetchResult(base, { url: "https://github.com/x/y", status: 200, toolNames: OPERATOR })).toBe(base);
	});

	it("keeps the original content and adds the note after it", () => {
		const base = { name: "fetch_url", content: "HTTP 404 Not Found: (no response body)", success: false };
		const out = annotateFetchResult(base, { url: "https://github.com/x/y", status: 404, toolNames: OPERATOR });
		expect(out.content.startsWith("HTTP 404 Not Found: (no response body)")).toBe(true);
		expect(out.content).toContain("PLATFORM NOTE");
		expect(out.success).toBe(false);
	});

	it("never lands inside the untrusted fence", () => {
		// The body is fenced and the note is the platform's own voice; if it fell inside the block
		// the model would be told to treat the platform's instruction as attacker-authored data.
		const base = {
			name: "fetch_url",
			content: '<untrusted_reference_material origin="the page at https://github.com/x/y">\nx\n\nbody\n</untrusted_reference_material>',
			success: false,
		};
		const out = annotateFetchResult(base, { url: "https://github.com/x/y", status: 404, toolNames: OPERATOR });
		const noteAt = out.content.indexOf("PLATFORM NOTE");
		expect(noteAt).toBeGreaterThan(out.content.lastIndexOf("</untrusted_reference_material>"));
	});
});

describe("the naming convention this module relies on", () => {
	it("every GitHub connector tool starts with the prefix the diagnosis matches on", () => {
		// The module asks "does this agent hold a tool for this host" by prefix rather than by
		// importing the registry, to keep lib/tools.ts out of the connector import graph. That is
		// only sound while the convention holds, so the convention is asserted rather than assumed:
		// a GitHub tool named without the prefix would make the note claim an absence that is false.
		expect(GITHUB_CONNECTOR.id).toBe("github");
		expect(GITHUB_CONNECTOR.tools.length).toBeGreaterThan(0);
		for (const t of GITHUB_CONNECTOR.tools) expect(t.name.startsWith("github_")).toBe(true);
	});
});
