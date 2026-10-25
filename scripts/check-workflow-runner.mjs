#!/usr/bin/env node
/**
 * check-workflow-runner.mjs — a workflow that installs or runs Playwright must not float on `*-latest` (#1266).
 *
 * GitHub moved `ubuntu-latest` to Ubuntu 26.04 on 2026-10-21 and Playwright does not support chromium there ("ERROR: Playwright does
 * not support chromium on ubuntu26.04-x64"): 21 browser-runner tests failed, main went red and the API worker stopped deploying.
 * The fix was to pin every such workflow to `ubuntu-24.04`. This keeps it pinned: any workflow that mentions `playwright` or
 * `browser-runner` (case-insensitive) must give every `runs-on:` a specific image — not `ubuntu-latest` (or any `-latest` label), not a
 * bare `ubuntu`, and not an expression this check cannot read. Unpin by changing the images here on purpose, once Playwright supports the
 * new one.
 *
 * Run: `node scripts/check-workflow-runner.mjs`
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");

/** Does this workflow install or run Playwright (or the package that does)? */
export const touchesPlaywright = (text) => /playwright|browser-runner/i.test(text);

/** The `runs-on:` values of a workflow, with their line numbers; comments stripped, flow lists expanded. */
export function runsOnValues(text) {
	const out = [];
	text.split(/\r?\n/).forEach((raw, i) => {
		const line = raw.replace(/\s+#.*$/, "");
		const m = line.match(/^\s*runs-on:\s*(.*)$/);
		if (!m) return;
		const value = m[1].trim();
		if (!value) return; // a block list / group: the entries are matched below as `- label` lines
		const items = value.startsWith("[") ? value.replace(/^\[|\]$/g, "").split(",") : [value];
		for (const item of items) out.push({ line: i + 1, value: item.trim().replace(/^["']|["']$/g, "") });
	});
	return out;
}

/**
 * The one expression that is allowed (#1214): `fromJSON(vars.PAGS_RUNNER || '"<image>"')`. The platform sets PAGS_RUNNER to the
 * pinned self-hosted machine's own labels when Actions minutes run out; with it unset the job runs on `<image>`, which must itself
 * be a pin. Any other expression stays unreadable to this check.
 */
export const PAGS_RUNNER_EXPR = /^\$\{\{\s*fromJSON\(vars\.PAGS_RUNNER\s*\|\|\s*'"([^"']+)"'\)\s*\}\}$/;

/** Why this image label is not a pin, or null when it is. */
export function floatingReason(label) {
	if (!label) return "empty";
	const routed = PAGS_RUNNER_EXPR.exec(label);
	if (routed) return floatingReason(routed[1]);
	if (label.includes("${{")) return "an expression (the image cannot be checked)";
	if (/-latest$/i.test(label)) return "a floating `-latest` image";
	if (/^(ubuntu|macos|windows)$/i.test(label)) return "no version";
	return null;
}

/** Violations in one workflow's text: [{ line, value, reason }]. Empty when it does not touch Playwright or all images are pinned. */
export function violationsIn(text) {
	if (!touchesPlaywright(text)) return [];
	return runsOnValues(text).flatMap(({ line, value }) => {
		const reason = floatingReason(value);
		return reason ? [{ line, value, reason }] : [];
	});
}

function main() {
	const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort();
	const bad = [];
	let checked = 0;
	for (const f of files) {
		const text = readFileSync(join(WORKFLOWS, f), "utf8");
		if (touchesPlaywright(text)) checked++;
		for (const v of violationsIn(text)) bad.push(`  ${f}:${v.line}  runs-on: ${v.value}  — ${v.reason}`);
	}
	if (bad.length) {
		console.error(`✗ Workflow runner pin (#1266): a workflow that installs or runs Playwright floats on its runner image.\n${bad.join("\n")}\n\n  Pin it to a specific image (ubuntu-24.04). ubuntu-latest moved to 26.04, where Playwright does not support chromium, and main went red.`);
		process.exit(1);
	}
	if (!checked) {
		console.error("✗ Workflow runner pin (#1266): no workflow under .github/workflows mentions Playwright or browser-runner — the guard would verify nothing.");
		process.exit(1);
	}
	console.log(`✓ Workflow runner pin OK — ${checked} Playwright-touching workflow(s) of ${files.length}, every runs-on pinned to a specific image.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
