/**
 * The turn this module exists for (#528) is the first describe, written as it happened rather than
 * as a unit case: a `repo_read_file` returns `admin/lib/.../pages/event_form_dialog.dart`, and the
 * model then files an issue naming `app/lib/.../widgets/event_form_dialog.dart`.
 *
 * The three silent cases carry as much weight as the loud one, because a warning that fires on an
 * ordinary create-a-file objective would be switched off within a week — so each is asserted as a
 * fact (no notice, and for the untouched case, reference equality), not as the absence of a word.
 *
 * ADR 0002: this file's scanner is hand-rolled, so the denominators are assertions — how many paths
 * the extractor found in a realistic result, and that the argument fields the module reads are the
 * ones the REAL tool schemas declare. A rename of `objective` would otherwise make the whole module
 * silently stop measuring.
 *
 * ADR 0002 G4 — watched to fail before it landed, twice, because a guard that has only ever been
 * green is evidence of nothing:
 *   * key the ledger by the FULL path instead of the basename (the collision rule removed) → 9 of
 *     22 red, including every assertion about the incident;
 *   * rename the sink field `objective` → `goal` (the module reading an argument that is never
 *     there) → 5 red, and the schema pin below is one of them, which is the arm that matters: every
 *     fixture-driven test in this file would otherwise still pass on a module gone silent.
 */
import { describe, expect, it } from "vitest";
import {
	CORROBORATED_SINKS,
	corroborateToolPaths,
	createPathLedger,
	extractPaths,
	findMismatches,
	pathCorroborationNotice,
	recordToolPaths,
} from "./path-corroboration.js";
import { getRegistryTool } from "./tool-registry.js";

/** What `repo_read_file` returned at 23:19:39Z, in the shape a result arrives in. */
const REAL_RESULT =
	"admin/lib/features/events/ui/pages/event_form_dialog.dart (312 lines)\n" +
	"```dart\n" +
	"  return Dialog(\n" +
	"    child: SizedBox(width: 480, child: Column(children: [\n" +
	"```\n";

/** What the agent then wrote into issue #224's body — same filename, different module and folder. */
const INVENTED = "app/lib/features/events/ui/widgets/event_form_dialog.dart";

function ledgerFrom(...results: string[]) {
	const ledger = createPathLedger();
	for (const r of results) recordToolPaths(ledger, "repo_read_file", r, true);
	return ledger;
}

describe("the incident that produced this module (#528)", () => {
	const ledger = ledgerFrom(REAL_RESULT);
	const note = pathCorroborationNotice(ledger, "github_create_issue", {
		repo: "HeartFull-online/platform",
		title: "Event form dialog is too narrow",
		body: `The width is hardcoded.\n\n**Affected file**: \`${INVENTED}\``,
	});

	it("names BOTH paths — the one written and the one the turn's tools returned", () => {
		expect(note).toContain(INVENTED);
		expect(note).toContain("admin/lib/features/events/ui/pages/event_form_dialog.dart");
	});

	it("states it as evidence about this turn, not as a claim about the filesystem", () => {
		// The ledger holds what RESULTS CONTAINED. Wording that promised "the real path" would be a
		// claim the module cannot support — a tool that echoes its own arguments can seed the ledger.
		expect(note).toContain("contradicts what this turn's tools returned");
		expect(note).not.toMatch(/does not exist/i);
	});

	it("says the call went through, so the model corrects rather than retries or apologises", () => {
		expect(note).toContain("already been filed");
		expect(note).toContain("nothing was blocked or changed");
	});

	it("leaves the deliberate-new-file reading open, which is what stops it being a rule", () => {
		expect(note).toContain("NEW file");
		expect(note).toContain("legitimate");
	});

	it("catches the same turn's second half: the objective that sent the Pilot hunting", () => {
		// `start_work` took the invented path too, and four of a six-step run were spent on it.
		const objectiveNote = pathCorroborationNotice(ledger, "start_work", {
			objective: `Fix the dialog width in ${INVENTED} — use the exact path.`,
		});
		expect(objectiveNote).toContain("The run has already started");
		expect(objectiveNote).toContain("admin/lib/features/events/ui/pages/event_form_dialog.dart");
	});

	it("catches the other file the same turn got wrong: app/pubspec.yaml vs admin/pubspec.yaml", () => {
		const l = ledgerFrom("admin/pubspec.yaml\nadmin/lib/main.dart\n");
		const n = pathCorroborationNotice(l, "start_work", { objective: "Bump the version in app/pubspec.yaml and deploy." });
		expect(n).toContain("`app/pubspec.yaml`");
		expect(n).toContain("`admin/pubspec.yaml`");
	});
});

describe("the silent cases — acceptance criteria 2 and 3", () => {
	it("a genuinely new file is not flagged: no tool returned that FILENAME at all", () => {
		// The distinguisher. Creating a file is ordinary work, and an objective naming one that does
		// not exist yet is the normal shape of a coding goal.
		const ledger = ledgerFrom(REAL_RESULT);
		const note = pathCorroborationNotice(ledger, "start_work", {
			objective: "Add admin/lib/features/events/ui/widgets/event_width_banner.dart with a warning strip.",
		});
		expect(note).toBe("");
		expect(findMismatches(ledger, "admin/lib/features/events/ui/widgets/event_width_banner.dart")).toEqual([]);
	});

	it("a path that MATCHES what the tools returned is not flagged", () => {
		const ledger = ledgerFrom(REAL_RESULT);
		expect(
			pathCorroborationNotice(ledger, "github_create_issue", {
				body: "**Affected file**: `admin/lib/features/events/ui/pages/event_form_dialog.dart`",
			}),
		).toBe("");
	});

	it("the same file quoted relative to a subdirectory is a match, not a contradiction", () => {
		const ledger = ledgerFrom(REAL_RESULT);
		expect(pathCorroborationNotice(ledger, "start_work", { objective: "Widen ui/pages/event_form_dialog.dart." })).toBe("");
	});

	it("a turn with no path-shaped strings leaves the result BYTE-identical, and the same object", () => {
		const ledger = ledgerFrom("Read 3 issues: #12 open, #13 open, #14 closed. No files touched.");
		const result = { name: "start_work", content: "Started work on: triage the open issues (run r_1).", success: true };
		const out = corroborateToolPaths(ledger, result, "start_work", { objective: "Triage the open issues and report." });
		expect(out.content).toBe("Started work on: triage the open issues (run r_1).");
		expect(out).toBe(result);
		expect(out.success).toBe(true);
	});

	it("a non-sink tool is never annotated, however wrong its arguments look", () => {
		const ledger = ledgerFrom(REAL_RESULT);
		const result = { name: "write_memory", content: "ok", success: true };
		expect(corroborateToolPaths(ledger, result, "write_memory", { value: INVENTED })).toBe(result);
	});
});

describe("what the ledger will and will not absorb", () => {
	it("a FAILED result is not evidence — an error message is not a tree", () => {
		const ledger = createPathLedger();
		recordToolPaths(ledger, "repo_read_file", "Not found: admin/lib/features/events/ui/pages/event_form_dialog.dart", false);
		expect(ledger.size).toBe(0);
	});

	it("a sink cannot corroborate itself: start_work echoes its own objective back", () => {
		// Without this, one invented path in round 1 would vouch for the same path in round 2.
		const ledger = createPathLedger();
		recordToolPaths(ledger, "start_work", `Started work on: fix ${INVENTED} (run r_1).`, true);
		expect(ledger.size).toBe(0);
	});

	it("the check runs BEFORE the absorb, so a result never vouches for the call it came from", () => {
		const ledger = ledgerFrom(REAL_RESULT);
		const out = corroborateToolPaths(
			ledger,
			{ name: "start_work", content: `Started work on: fix ${INVENTED} (run r_1).`, success: true },
			"start_work",
			{ objective: `fix ${INVENTED}` },
		);
		expect(out.content).toContain("PLATFORM NOTE");
		expect(out.success).toBe(true); // evidence, not a refusal
	});
});

describe("the extractor states its own size and its own limits (ADR 0002)", () => {
	const TREE =
		"admin/lib/main.dart\n" +
		"admin/lib/features/events/ui/pages/event_form_dialog.dart\n" +
		"admin/pubspec.yaml\n" +
		"./app/web/index.html\n" +
		"see https://github.com/HeartFull-online/platform/blob/main/admin/lib/main.dart for context\n" +
		"repo HeartFull-online/platform, branch main\n";

	it("finds exactly the four file paths in that block — the denominator, not just 'some'", () => {
		// If this number moves, the regex changed and every silence below became untrustworthy.
		expect(extractPaths(TREE)).toEqual([
			"admin/lib/main.dart",
			"admin/lib/features/events/ui/pages/event_form_dialog.dart",
			"admin/pubspec.yaml",
			"app/web/index.html",
		]);
	});

	it("excludes owner/repo, which is an argument of every call this annotates", () => {
		expect(extractPaths("repo HeartFull-online/platform")).toEqual([]);
	});

	it("excludes URLs, so a blob link cannot enter the ledger with blob/main glued on", () => {
		expect(extractPaths("https://github.com/o/r/blob/main/admin/lib/main.dart")).toEqual([]);
	});

	it("does NOT handle a Windows path — stated here rather than discovered later", () => {
		expect(extractPaths("admin\\lib\\main.dart")).toEqual([]);
	});

	it("normalizes ./ and / so one file is one ledger entry", () => {
		const ledger = ledgerFrom("./admin/lib/main.dart\n/admin/lib/main.dart\nadmin/lib/main.dart\n");
		expect(ledger.get("main.dart")).toEqual(new Set(["admin/lib/main.dart"]));
	});

	it("bounds one notice: at most three offending paths, at most three known paths each", () => {
		const ledger = ledgerFrom("a1/x.ts\na2/x.ts\na3/x.ts\na4/x.ts\nb/y.ts\nc/z.ts\nd/w.ts\n");
		const mismatches = findMismatches(ledger, "q/x.ts q/y.ts q/z.ts q/w.ts");
		expect(mismatches).toHaveLength(3);
		const note = pathCorroborationNotice(ledger, "start_work", { objective: "touch q/x.ts q/y.ts q/z.ts q/w.ts" });
		expect(note).toContain("and 1 more");
		expect(note).not.toContain("q/w.ts");
	});
});

describe("the sink table is pinned to the REAL tool schemas (ADR 0002, G1)", () => {
	it("covers both sinks #528 named and nothing has quietly dropped out", () => {
		expect(Object.keys(CORROBORATED_SINKS).sort()).toEqual(["github_create_issue", "start_work"]);
	});

	it("every field it reads is a real string property of that tool's live schema", () => {
		// The failure this catches is total silence: rename `objective` to `goal` and the module
		// checks an argument that is never present, while every test above still passes on fixtures.
		let checked = 0;
		for (const [tool, sink] of Object.entries(CORROBORATED_SINKS)) {
			const schema = getRegistryTool(tool)?.jsonSchema as { properties?: Record<string, { type?: string }> } | undefined;
			expect(schema?.properties, `${tool} is not a registry tool any more`).toBeTruthy();
			for (const field of sink.fields) {
				expect(schema?.properties?.[field], `${tool}.${field} is not in the tool's schema`).toBeTruthy();
				expect(schema?.properties?.[field]?.type).toBe("string");
				checked++;
			}
		}
		expect(checked, "no sink fields were checked — the table or the registry lookup is broken").toBe(3);
	});
});
