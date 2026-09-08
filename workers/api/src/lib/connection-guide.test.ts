import { describe, expect, it } from "vitest";
import {
	buildConnectionGuide,
	CONNECTION_GUIDE_MAX_CHARS,
	type ConnectionGuideInput,
	describeToolFields,
	GUIDE_TRUNCATION_NOTICE,
	renderCallExample,
} from "./connection-guide.js";

/**
 * The shape #772 was filed from: a coding instance with GitHub connector tools, where the
 * reporter guessed tool names and then guessed field names before landing on the right call.
 */
const GITHUB_ISSUES: ConnectionGuideInput["tools"][number] = {
	name: "github_list_issues",
	description: "List issues for a repo (excludes pull requests).",
	invocableBy: ["chat", "call_instance_tool"],
	tier: "connector",
	connector: "github",
	mutates: false,
	writeConsent: "n/a",
	jsonSchema: {
		type: "object",
		properties: {
			repo: { type: "string", description: 'The repository, "owner/name".' },
			state: { type: "string" },
			labels: { type: "string" },
		},
		required: ["repo"],
	},
};

const CREATE_ISSUE: ConnectionGuideInput["tools"][number] = {
	name: "github_create_issue",
	invocableBy: ["chat", "call_instance_tool"],
	tier: "connector",
	connector: "github",
	mutates: true,
	writeConsent: "required",
	jsonSchema: {
		type: "object",
		properties: { repo: { type: "string" }, title: { type: "string" }, body: { type: "string" } },
		required: ["repo", "title"],
	},
};

/** A BASE facility. `invocableBy:["chat"]` — the registry route cannot reach it (#525). */
const WRITE_MEMORY: ConnectionGuideInput["tools"][number] = {
	name: "write_memory",
	invocableBy: ["chat"],
	tier: "base",
	mutates: true,
	jsonSchema: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"] },
};

function input(over: Partial<ConnectionGuideInput> = {}): ConnectionGuideInput {
	return {
		instanceId: "a185b1db-c560-456d-9522-f7792bd95cca",
		instanceName: "Repo Coder",
		agentSlug: "coder-repo",
		surfaces: ["coding"],
		runtime: "coding",
		tools: [GITHUB_ISSUES, CREATE_ISSUE, WRITE_MEMORY],
		repos: [{ name: "platform", githubRepo: "ProAgentStore/platform" }],
		manual: "",
		rules: "",
		...over,
	};
}

describe("the exact contract a caller was guessing", () => {
	it("names the instance id as the thing to send, not just as a heading", () => {
		const guide = buildConnectionGuide(input());
		expect(guide).toContain("a185b1db-c560-456d-9522-f7792bd95cca");
		expect(guide).toContain("`instance_id`");
	});

	it("lists every field name a tool takes, split into required and optional", () => {
		// This is the half of #772 that fixes guessed FIELD names. The names must be exact and the
		// required/optional split must be real, or the caller is guessing again with more prose.
		const line = describeToolFields(GITHUB_ISSUES);
		expect(line).toContain("required: `repo`");
		expect(line).toContain("optional: `state`, `labels`");
		expect(line).not.toContain("`repo`, `state`"); // required must not swallow the optional ones
	});

	it("says so out loud when a tool takes no arguments", () => {
		// The alternative is a caller inventing an argument for a tool that accepts none.
		expect(describeToolFields({ name: "whoami", invocableBy: ["call_instance_tool"] })).toBe(
			"takes no arguments — send `{}`",
		);
		expect(describeToolFields({ name: "whoami", jsonSchema: { type: "object", properties: {} } })).toBe(
			"takes no arguments — send `{}`",
		);
	});

	it("renders a worked example that is valid JSON with the real tool and field names", () => {
		const example = renderCallExample("inst-1", GITHUB_ISSUES);
		const json = example.replace(/^```json\n/, "").replace(/\n```$/, "");
		expect(JSON.parse(json)).toEqual({
			instance_id: "inst-1",
			tool: "github_list_issues",
			input: { repo: "<repo>" },
		});
	});

	it("puts only REQUIRED fields in the example", () => {
		// An example carrying every optional argument reads as though they are all expected —
		// which trades one guessing problem for another.
		const json = renderCallExample("inst-1", CREATE_ISSUE).replace(/^```json\n/, "").replace(/\n```$/, "");
		expect(Object.keys(JSON.parse(json).input)).toEqual(["repo", "title"]);
	});

	it("types placeholders from the schema instead of inventing plausible values", () => {
		const tool = {
			name: "t",
			jsonSchema: {
				properties: { a: { type: "string" }, b: { type: "number" }, c: { type: "boolean" }, d: { type: "array" }, e: { type: "object" }, f: {} },
				required: ["a", "b", "c", "d", "e", "f"],
			},
		};
		const json = renderCallExample("i", tool).replace(/^```json\n/, "").replace(/\n```$/, "");
		expect(JSON.parse(json).input).toEqual({ a: "<a>", b: 0, c: false, d: [], e: {}, f: "<f>" });
	});

	it("keeps the example parseable so it can be pasted", () => {
		// The whole value of an angle-bracketed placeholder is that it is visibly fake AND still
		// parses. A bare <repo> outside quotes would fail here.
		const guide = buildConnectionGuide(input());
		const block = guide.match(/```json\n([\s\S]*?)\n```/);
		expect(block).not.toBeNull();
		expect(() => JSON.parse((block as RegExpMatchArray)[1])).not.toThrow();
	});
});

describe("what call_instance_tool can and cannot reach", () => {
	it("separates callable tools from chat-only ones", () => {
		// `invocableBy` exists because the description that flattened the two claimed a guarantee
		// for chat that only held for the invoker (ToolPolicyEntry, #525). A guide that flattened
		// it again would send a caller to invoke a tool that always errors.
		const guide = buildConnectionGuide(input());
		expect(guide).toContain("Callable via `call_instance_tool` (2)");
		expect(guide).toContain("Chat-only (1)");
		const callableSection = guide.slice(guide.indexOf("Callable via"), guide.indexOf("Chat-only"));
		expect(callableSection).toContain("github_list_issues");
		expect(callableSection).not.toContain("write_memory");
	});

	it("picks the worked example from a CALLABLE tool, never a chat-only one", () => {
		const guide = buildConnectionGuide(input({ tools: [WRITE_MEMORY, GITHUB_ISSUES] }));
		const json = (guide.match(/```json\n([\s\S]*?)\n```/) as RegExpMatchArray)[1];
		expect(JSON.parse(json).tool).toBe("github_list_issues");
	});

	it("says plainly when nothing is reachable, instead of rendering an empty example", () => {
		// A chat/RAG agent is this shape, and a caller told to keep hunting for a callable tool
		// would hunt forever.
		const guide = buildConnectionGuide(input({ tools: [WRITE_MEMORY] }));
		expect(guide).toContain("no tool reachable through `call_instance_tool`");
		expect(guide).toContain("chat_with_instance");
		expect(guide).not.toContain("```json");
	});

	it("marks writes and consent gates so a caller knows what a call costs", () => {
		const guide = buildConnectionGuide(input());
		expect(guide).toContain("`github_create_issue`");
		expect(guide).toMatch(/github_create_issue.*\*\*writes\*\*/);
		expect(guide).toMatch(/github_create_issue.*consent: required/);
		// A read must not be labelled a write.
		expect(guide).not.toMatch(/github_list_issues.*\*\*writes\*\*/);
	});
});

describe("live facts, rendered per call", () => {
	it("reports the agent type and surfaces", () => {
		const guide = buildConnectionGuide(input());
		expect(guide).toContain("`coder-repo`");
		expect(guide).toContain("`coding`");
	});

	it("tells a runner-backed agent it needs `pags up`, and a cloud-only one that it does not", () => {
		// Telling a caller to run `pags up` for a cloud-only agent is a wrong instruction that
		// costs a whole debugging session, so the two branches are asserted separately.
		expect(buildConnectionGuide(input({ runtime: "coding" }))).toContain("`pags up`");
		const cloud = buildConnectionGuide(input({ runtime: null }));
		expect(cloud).toContain("runs entirely on the platform");
		expect(cloud).toContain("there is no `pags up` to start");
	});

	it("names the registered repo when there is one, and omits the section when there is not", () => {
		expect(buildConnectionGuide(input())).toContain("ProAgentStore/platform");
		expect(buildConnectionGuide(input({ repos: [] }))).not.toContain("## Repositories attached");
	});

	it("describes a local checkout by its path rather than claiming a GitHub coordinate", () => {
		const guide = buildConnectionGuide(input({ repos: [{ name: "site", workdir: "/Users/x/dev/site" }] }));
		expect(guide).toContain("local checkout at `/Users/x/dev/site`");
	});

	it("handles an instance with no tools at all without pretending otherwise", () => {
		const guide = buildConnectionGuide(input({ tools: [], repos: [] }));
		expect(guide).toContain("_None. This instance has no tools enabled._");
	});
});

describe("the owner's prose, and whose instructions it is", () => {
	it("includes the operator manual verbatim", () => {
		const manual = "Drive this one through call_instance_tool, not the terminal.";
		expect(buildConnectionGuide(input({ manual }))).toContain(manual);
	});

	it("labels the agent's standing orders as the AGENT's, not the caller's", () => {
		// #739's whole defect: caller-facing prose and agent orders in one box, so a note ABOUT
		// driving the agent became an order the agent enforced. The guide must not re-merge them.
		const guide = buildConnectionGuide(input({ rules: "Never mention file paths." }));
		expect(guide).toContain("## The agent's standing orders");
		expect(guide).toContain("instructions to the **agent**, not to you");
		expect(guide).toContain("Never mention file paths.");
	});

	it("omits both sections when unset, including whitespace-only", () => {
		// A cleared textarea stores "\n", not "" — a heading over an empty body reads as a fact.
		const guide = buildConnectionGuide(input({ manual: "  \n\t ", rules: "" }));
		expect(guide).not.toContain("## Operating notes from the owner");
		expect(guide).not.toContain("## The agent's standing orders");
	});
});

describe("size is bounded, and says when it bit", () => {
	it("stays well inside the cap for a realistic instance", () => {
		expect(buildConnectionGuide(input()).length).toBeLessThan(CONNECTION_GUIDE_MAX_CHARS);
	});

	it("truncates with a notice rather than letting a host drop the response", () => {
		// `list_instance_tools` overflows a 64 KiB host limit on real instances (base.ts:52-98).
		// This guide is smaller by construction, and "smaller by construction" is exactly the claim
		// that stops being true when a catalogue grows.
		const guide = buildConnectionGuide(input({ manual: "x".repeat(CONNECTION_GUIDE_MAX_CHARS * 2) }));
		expect(guide.length).toBe(CONNECTION_GUIDE_MAX_CHARS);
		expect(guide.endsWith(GUIDE_TRUNCATION_NOTICE)).toBe(true);
		expect(guide).toContain("list_instance_tools");
	});
});

describe("nothing is written", () => {
	it("is pure — the same input renders byte-identically, and the input is not mutated", () => {
		// The rule #739 Decision 4 settled: a generated fact frozen into storage goes stale inside
		// PAGS exactly as it goes stale inside a Claude project. Purity is what makes "render every
		// time" cheap enough to be the answer.
		const args = input();
		const frozen = JSON.stringify(args);
		expect(buildConnectionGuide(args)).toBe(buildConnectionGuide(args));
		expect(JSON.stringify(args)).toBe(frozen);
	});
});
