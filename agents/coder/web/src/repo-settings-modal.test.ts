import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The repo settings sheet: what you can CHANGE, and what merely looks like you can (#410/#411).
 *
 * Two defects lived here, and the second is why the first went unreported for so long.
 *
 *   1. The folder could not be changed. `PUT /coding/repos/:repoId` had no `workdir` parameter,
 *      so there was no request the console could have sent. The only remedy was DELETE, which
 *      takes the name, the URLs, the merge policy, the instructions and the issue mode with it —
 *      and the row is the foreign key for `coding_sessions` and `coding_timeline`, so correcting
 *      a typo meant destroying the history.
 *
 *   2. It LOOKED changeable. `Detail` rendered `bg-paper border border-line rounded-lg p-2` with a
 *      `font-mono` value; the inputs two components away are `bg-panel border border-line
 *      rounded-xl px-3 py-2`, and `font-mono` is what this console reserves for path/command
 *      INPUTS. The only difference was #0a0a0a against #141414 on a dark-only theme. So the owner
 *      edited what they reasonably took for the field, the app accepted it, and the agent went on
 *      reading the old directory.
 *
 * Asserted on the source: these are conditional JSX and Tailwind classes, and the value is that
 * the control exists and is wired end to end, not how React renders it. Same technique as
 * ./repos-list.test.ts.
 */
const src = readFileSync(join(import.meta.dirname, "RepoSettingsModal.tsx"), "utf8");

/** Source with comments stripped — several assertions forbid a string the comment explaining the
 *  fix necessarily contains. */
const code = src
	.replace(/\/\*[\s\S]*?\*\//g, "")
	.split("\n")
	.map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
	.join("\n");

describe("the folder is a real field", () => {
	it("renders an input, not a Detail row", () => {
		expect(code).toContain('id="repo-settings-workdir"');
		// Asserted as "the handler writes the field's own state", not as a literal: this used to pin
		// the whole `onChange` string and went red when #67 added a third clearer to it, which is a
		// test failing for a change that could not possibly be the defect it guards. What must stay
		// true is that typing reaches `setWorkdir` — a read-only `Detail` has no handler at all.
		expect(code).toMatch(/onChange=\{\(e\) => \{[^}]*setWorkdir\(e\.target\.value\)/);
		// The old read-only row is gone from the details grid.
		expect(code).not.toContain('<Detail label="Folder"');
	});

	it("sends it on the existing PUT — one destination, not a second one", () => {
		// "Two entry points are acceptable IF they write the same place" is the whole lesson of
		// #411; a second endpoint for the same fact would be the defect again in a new shape.
		expect(code).toContain("workdir: folder");
		expect(code).toContain(`method: "PUT"`);
	});

	it("refuses to blank it client-side too — that is a delete", () => {
		expect(code).toContain("if (!folder && repo.workdir)");
		expect(code).toMatch(/A folder is required\. To remove this repo, use Delete\./);
	});
});

describe("the verdict lands beside the field, not in an alert", () => {
	it("keeps the sheet open on a stored-but-unusable path", () => {
		// The server stores a broken path and marks it (the owner may be on a phone with the
		// machine shut). Closing on that warning would put the diagnosis on a screen they have
		// just left — which is how #405's empty directory survived two days.
		expect(code).toContain("if (res?.warning)");
		expect(code).toContain('setFolderNote({ kind: "warn", text: res.warning })');
	});

	it("shows a refusal — blank, or a session still in the old directory — under the field", () => {
		expect(code).toContain("/folder|session is running/i");
		expect(code).toContain('data-testid="repo-settings-folder-note"');
	});
});

describe("a read-only value does not wear an input's costume", () => {
	const detail = code.slice(code.indexOf("function Detail("));

	it("drops the border and the panel background that made it look like a field", () => {
		expect(detail).not.toContain("border border-line");
		expect(detail).not.toContain("bg-paper");
	});

	it("dims the value and marks it locked, so the difference is visible not inferred", () => {
		expect(detail).toContain("text-muted");
		expect(detail).toContain("<Lock");
		expect(detail).not.toContain("text-ink");
	});
});

/**
 * #67 — the sheet says WHICH part of a plausible-looking path is wrong.
 *
 * The incident: an owner created a Repo Coder against a path with one extra segment, and three
 * minutes forty seconds later subscribed a SECOND instance against the same repository rather
 * than correcting it. The machine's verdict existed the whole time, on the repo row. It reached
 * this sheet — the one place the path can actually be edited — nowhere.
 */
describe("the standing verdict is shown above the field that answers it (#67)", () => {
	it("reads the verdict from the shared decision rather than re-testing the status here", () => {
		// One module decides what `needs_attention` means and what to say about it, so the sheet,
		// the list banner and the solo surface cannot describe one directory three ways.
		expect(code).toContain('import { repoRepairNotice } from "./repo-repair"');
		expect(code).toContain("repoRepairNotice(repo)?.sentence");
	});

	it("renders it, and distinguishably from the note about the save in flight", () => {
		expect(code).toContain('data-testid="repo-settings-clone-error"');
		// Two different facts, two different test ids: one is the verdict that brought you here,
		// the other is what the server said about the save you just made.
		expect(code).toContain('data-testid="repo-settings-folder-note"');
	});

	it("clears the moment the field is edited — it describes a path no longer in the box", () => {
		expect(code).toMatch(/onChange=\{\(e\) => \{[^}]*setStandingVerdict\(""\)/);
	});
});
