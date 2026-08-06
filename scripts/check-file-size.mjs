#!/usr/bin/env node
// CI guard (#302): a size RATCHET over the known-large source files.
//
// ── Why this exists
//
// `packages/sdk/src/voice/use-voice.ts`, measured over one day (#302):
//
//     1127  when #138 was filed
//     1441  the morning of the refactor
//     1315  after f194a72, the refactor itself — 126 lines removed, with tests
//     1532  hours later, larger than when the ticket that asked for it was filed
//
// f194a72 was good work: it measured why the three sub-hooks the ticket imagined were the
// wrong seams and extracted what genuinely separates instead. None of it survived contact
// with the next feature, because nothing held the ground it took. That is the gap this
// closes. It is the same shape as the #231 guard that greps for raw `UPDATE
// agent_instances SET config` — a reviewer cannot be expected to catch the seventeenth by
// eye, and "we should refactor that someday" is not a mechanism.
//
// ── What it enforces, in three directions
//
//   OVER the pin      -> fail. Split the file, or raise the pin ON PURPOSE in the same
//                        commit, which makes growth a decision someone signed.
//   UNDER pin - SLACK -> fail. This is the half that makes it a RATCHET rather than a
//                        ceiling. Without it, f194a72's 126 lines stay available as
//                        headroom and the file walks straight back up to its pin — which
//                        is precisely, numerically, what happened. Shrink the file, record
//                        the new floor.
//   NEW file > LIMIT  -> fail. A new file this size needs an entry, so adding one is a
//                        decision rather than a default.
//
// SLACK exists so ordinary editing does not trip the shrink arm on every deleted line. It
// is deliberately smaller than any refactor worth the name: 126 lines would be caught, a
// dozen lines of cleanup would not.
//
// ── Two deliberate exclusions
//
//   Tests. `*.test.ts`, `*.spec.ts` and `e2e/**` are not counted. #302's own observation is
//   that "the largest files are also the untested ones" — a guard that fires when you ADD
//   TESTS would punish the only thing that fixes the problem it is about.
//
//   Untracked files. The list comes from `git ls-files`, not a directory walk. That gets
//   generated output (`workers/host/src/pages.ts`, `store/docs/`), `dist/`, and the
//   per-session `.claude/worktrees/*` checkouts for free, rather than by maintaining a
//   fourth copy of the same ignore list.
//
// Lines are counted the way `wc -l` counts them, including blanks and comments. This
// codebase explains itself at length and that prose is genuinely load-bearing, so a
// "code lines only" metric would reward deleting the explanations. Size is a proxy for how
// much a reader must hold at once, and comments are part of that.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/** A new file above this needs a PINS entry. */
const LIMIT = 800;

/** How far a pinned file may shrink before the pin must be lowered. */
const SLACK = 40;

/**
 * file -> maximum lines. Measured at ee819e3 (main) on 2026-08-07.
 *
 * Lower one whenever you shrink the file — that is the normal case and the point of the
 * exercise. Raising one is allowed, but it is a statement that the file got bigger and
 * nobody split it, so say why in the commit message.
 */
const PINS = {
	// The five worst, and the two the #302 evidence is actually about.
	"workers/mcp/src/instance-tools/base.ts": 1871,
	"workers/api/src/routes/coding.ts": 1769,
	"workers/api/src/routes/instances.ts": 1696,
	"packages/sdk/src/voice/use-voice.ts": 1533,
	"store/console/src/pages/InstanceDetail.tsx": 1243,
	"agents/coder/web/src/CodingTab.tsx": 1217,
	"packages/browser-runner/src/runner.ts": 1208,
	"workers/api/src/lib/connectors/mcp.ts": 1191,
	"workers/mcp/src/index.ts": 1151,
	"store/console/src/tabs/SettingsTab.tsx": 1149,
	"workers/api/src/agent-do.ts": 1073,
	// +3 for #308: an import plus the two lines saying why three steps unwrap the fence that the
	// connectors now apply at the source. Raised rather than split — the growth is a comment and
	// one import, and splitting the step catalog to absorb three lines would be the tail wagging.
	"workers/api/src/lib/steps.ts": 988,
	"workers/api/src/agent-think.ts": 879,
	"workers/api/src/routes/instances-runtime.ts": 849,
	"workers/api/src/lib/triggers.ts": 838,
	"packages/browser-runner/src/coding/headless.ts": 819,
	"workers/api/src/routes/tools.ts": 811,
};

/**
 * #240 (stale tab data / cross-agent save) lived in `InstanceDetail.tsx`; #241
 * (unrecoverable offline state) lived in `CodingTab.tsx`. Both were found by reading,
 * because at 1200+ lines with no test file nothing else could find them. Named here so the
 * failure message can say why the number matters.
 */
const TICKET = "#302 — split it, or raise the pin on purpose";

const isTest = (f) => /\.(test|spec)\.(ts|tsx|mjs)$/.test(f) || f.startsWith("e2e/");
const isSource = (f) => /\.(ts|tsx|mjs)$/.test(f) && !/\.d\.ts$/.test(f);

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf-8" })
	.split("\n")
	.filter(Boolean)
	.filter((f) => isSource(f) && !isTest(f));

const lines = (f) => readFileSync(f, "utf-8").split("\n").length;

const problems = [];
const measured = new Map();

for (const file of tracked) {
	let n;
	try {
		n = lines(file);
	} catch {
		continue; // deleted in the working tree but still in the index
	}
	measured.set(file, n);
	const pin = PINS[file];

	if (pin === undefined) {
		if (n > LIMIT) {
			problems.push(
				`${file} is ${n} lines and has no entry in scripts/check-file-size.mjs.\n` +
					`      A new file over ${LIMIT} lines needs one, so that adding it is a decision. Add\n` +
					`      "${file}": ${n},  — or split it now, which is cheaper than it will ever be again.`,
			);
		}
		continue;
	}

	if (n > pin) {
		problems.push(
			`${file} grew to ${n} lines, pinned at ${pin} (+${n - pin}).\n` +
				`      ${TICKET}. If the growth is right, raise the pin in the same commit and say why.`,
		);
	} else if (n < pin - SLACK) {
		const advice =
			n <= LIMIT
				? `It is now under the ${LIMIT}-line threshold — delete its entry entirely.`
				: `Lower its entry to ${n}.`;
		problems.push(
			`${file} is ${n} lines but pinned at ${pin} (-${pin - n}). Good — record it.\n` +
				`      ${advice} Leaving the pin high hands the ${pin - n} lines you just removed back as\n` +
				`      headroom, which is exactly how the #138 refactor was undone within hours.`,
		);
	}
}

// A pin for a file that no longer exists is dead config, and dead config in a guard is how
// the guard stops being believed. Deleting or renaming the file is the good outcome; the
// entry just has to go with it.
for (const file of Object.keys(PINS)) {
	if (!measured.has(file) && !existsSync(file)) {
		problems.push(`${file} is pinned but no longer tracked (deleted or renamed). Remove its entry from scripts/check-file-size.mjs.`);
	}
}

if (problems.length) {
	console.error("✗ File-size ratchet (#302):\n");
	for (const p of problems) console.error(`  - ${p}\n`);
	process.exit(1);
}

const total = Object.values(PINS).reduce((a, b) => a + b, 0);
const actual = Object.keys(PINS).reduce((a, f) => a + (measured.get(f) ?? 0), 0);
console.log(`✓ File-size ratchet OK — ${Object.keys(PINS).length} pinned files at ${actual}/${total} lines; ${tracked.length} source files scanned, none new over ${LIMIT}.`);
