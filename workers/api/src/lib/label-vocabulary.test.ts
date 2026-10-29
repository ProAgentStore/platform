/**
 * #1245 — the label vocabulary an agent is told is the one the platform acts on. Every claim in the
 * text is held to the code it describes, and every tool that sets or filters labels carries it.
 */
import { describe, expect, it } from "vitest";
import { GITHUB_TOOLS } from "./connectors/github.js";
import { AUTO_PICKUP_DEFAULTS, exclusionReason, kindRank, pickNextIssue, priorityRank, type PickCandidate } from "./auto-pickup.js";
import { isNeedsHumanLabel } from "./fleet-snapshot.js";
import { coerceListFields, validateAgainstSchema } from "./json-schema-validate.js";
import { AREA_LABELS, BUILTIN_EXCLUDE_LABELS, DEFAULT_PRIORITY_LABELS, HIGH_SIGNAL_TYPE_LABELS, LABEL_FILTER_HINT, LABEL_LIST_FORMAT, LABEL_VOCABULARY, LOW_SIGNAL_TYPE_LABELS } from "./label-vocabulary.js";

const tool = (name: string) => {
	const t = GITHUB_TOOLS.find((x) => x.name === name);
	if (!t) throw new Error(`${name} is not a github tool`);
	return t;
};
const issue = (number: number, labels: string[]): PickCandidate => ({ repo: "acme/app", boardPosition: null, issue: { number, title: `Issue ${number}`, labels, assignees: [], url: "u", updatedAt: "" } } as unknown as PickCandidate);

describe("the vocabulary names exactly what the code acts on (#1245)", () => {
	it("every label auto-pickup skips is in the text, and auto-pickup does skip it", () => {
		for (const label of BUILTIN_EXCLUDE_LABELS) {
			expect(LABEL_VOCABULARY, label).toContain(`\`${label}\``);
			// Case-insensitive, exact — as exclusionReason compares.
			expect(exclusionReason(issue(1, [label.toUpperCase()]), { excludeLabels: [] }), label).toBe(`labelled \`${label}\``);
		}
	});

	it("the 'waiting on a person' labels are the ones the fleet snapshot and triage treat that way", () => {
		for (const waiting of ["needs-human", "human-only", "blocked", "blocked-on-serge"]) {
			expect(isNeedsHumanLabel(waiting), waiting).toBe(true);
			expect(LABEL_VOCABULARY, waiting).toContain(`\`${waiting}\``);
		}
		// `question` and `wontfix` are skipped by auto-pickup but are NOT waiting-on-a-person: the text does not say so.
		expect(isNeedsHumanLabel("question")).toBe(false);
		expect(isNeedsHumanLabel("wontfix")).toBe(false);
		expect(LABEL_VOCABULARY).not.toMatch(/`(?:question|wontfix)`[^.]*mean a person has to act/);
	});

	it("priority runs P0 → P3, and the repo's own label spelling ranks by its prefix", () => {
		expect([...DEFAULT_PRIORITY_LABELS]).toEqual(["P0", "P1", "P2", "P3"]);
		expect(AUTO_PICKUP_DEFAULTS.priorityLabels).toEqual([...DEFAULT_PRIORITY_LABELS]);
		for (const [i, spelled] of ["P0: wrong today", "P1: blocks external users", "P2: correctness", "P3: later"].entries()) {
			expect(priorityRank([spelled], AUTO_PICKUP_DEFAULTS.priorityLabels), spelled).toBe(i);
		}
		const next = pickNextIssue([issue(3, ["P2: correctness"]), issue(2, ["P0: wrong today"]), issue(1, [])], AUTO_PICKUP_DEFAULTS);
		expect(next.pick?.issue.number).toBe(2);
		for (const p of ["P0", "P1", "P2", "P3"]) expect(LABEL_VOCABULARY).toContain(`\`${p}\``);
	});

	it("bug/security/regression start before an unlabelled issue and enhancement after, as the text says (#1407)", () => {
		for (const high of HIGH_SIGNAL_TYPE_LABELS) expect(kindRank([high]), high).toBeLessThan(kindRank([]));
		for (const low of LOW_SIGNAL_TYPE_LABELS) expect(kindRank([]), low).toBeLessThan(kindRank([low]));
		for (const high of HIGH_SIGNAL_TYPE_LABELS) expect(LABEL_VOCABULARY, high).toContain(`\`${high}\``);
		expect(LABEL_VOCABULARY).toMatch(/`bug`, `security`, `regression` are started before an unlabelled issue, `enhancement` after/);
	});

	it("each area label is named once, with a meaning, and said to be this repo's own", () => {
		expect(new Set(AREA_LABELS.map(([n]) => n)).size).toBe(AREA_LABELS.length);
		for (const [name, meaning] of AREA_LABELS) {
			expect(meaning.length, name).toBeGreaterThan(3);
			expect(LABEL_VOCABULARY).toContain(`\`${name}\` (${meaning})`);
		}
		expect(LABEL_VOCABULARY).toContain("(other repos have their own)");
	});
});

describe("the list format is what the registry accepts (#1245)", () => {
	const example = "bug,P1: blocks external users";

	it("says STRING, accepts an array too, and the schema the model sees still declares a string", () => {
		expect(LABEL_LIST_FORMAT).toMatch(/comma-separated STRING/);
		expect(LABEL_LIST_FORMAT).toContain(example);
		expect(LABEL_LIST_FORMAT).toMatch(/array of names is accepted too/);
		for (const [name, field] of [["github_create_issue", "labels"], ["github_update_issue", "labels"], ["github_update_issue", "assignees"], ["github_list_issues", "labels"], ["github_list_issues", "exclude_labels"]] as const) {
			const t = tool(name);
			const base = name === "github_update_issue" ? { repo: "a/b", number: 1 } : name === "github_create_issue" ? { repo: "a/b", title: "t" } : { repo: "a/b" };
			// the schema is unchanged — string — so every consumer of it (model, pinned session) is
			expect((t.jsonSchema.properties as Record<string, { type: unknown }>)[field].type, `${name}.${field} declared type`).toBe("string");
			expect(t.listFields, `${name} lists ${field}`).toContain(field);
			expect(validateAgainstSchema(t.jsonSchema, { ...base, [field]: example }), `${name}.${field} string`).toBeNull();
			// the route coerces BEFORE validating, so an array reaches the handler as the string it already parses
			const coerced = coerceListFields(t.listFields, { ...base, [field]: ["bug", "mcp"] });
			expect(coerced.error, `${name}.${field}`).toBeNull();
			expect(coerced.input[field]).toBe("bug,mcp");
			expect(validateAgainstSchema(t.jsonSchema, coerced.input), `${name}.${field} array, after coercion`).toBeNull();
			// the bare validator still judges the declared type
			expect(validateAgainstSchema(t.jsonSchema, { ...base, [field]: ["bug", "mcp"] }), `${name}.${field} uncoerced`).toBe(`Field "${field}" must be a string`);
		}
	});
});

describe("every tool that sets or filters labels carries it (#1245)", () => {
	it("github_create_issue and github_update_issue publish the vocabulary in their description and the format on `labels`", () => {
		for (const name of ["github_create_issue", "github_update_issue"]) {
			const t = tool(name);
			expect(t.description, name).toContain(LABEL_VOCABULARY);
			expect((t.jsonSchema.properties as Record<string, { description: string }>).labels.description, name).toContain(LABEL_LIST_FORMAT);
		}
		// The replace-not-add rule stays where it was said.
		expect(tool("github_update_issue").description).toMatch(/`labels` and `assignees` REPLACE/);
	});

	it("github_list_issues publishes the format and the short form on `labels` and `exclude_labels`", () => {
		const props = tool("github_list_issues").jsonSchema.properties as Record<string, { description: string }>;
		expect(props.labels.description).toContain(LABEL_LIST_FORMAT);
		expect(props.labels.description).toContain(LABEL_FILTER_HINT);
		expect(props.exclude_labels.description).toContain(LABEL_LIST_FORMAT);
		expect(props.exclude_labels.description).toMatch(/needs-human/);
	});

	it("the short form's claims match the long one's labels", () => {
		for (const l of ["needs-human", "human-only", "blocked", "question", "wontfix", "P0", "P3", "bug", "enhancement"]) expect(LABEL_FILTER_HINT).toContain(l);
		expect(BUILTIN_EXCLUDE_LABELS).toContain("question");
	});
});
