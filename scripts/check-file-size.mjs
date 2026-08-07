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
	//
	// `workers/mcp/src/instance-tools/base.ts` was the largest of them at 1871 lines and 67
	// tool registrations. #305 split it along the registration boundaries it already had into
	// nine group modules (base/runtime/knowledge/observability/board/settings/triggers/
	// composition/account), the largest of which is under 300 lines — so its entry is gone
	// rather than lowered, which is what this guard asks for when a file drops under LIMIT.
	//
	// +5 at #314: `mergePolicy` on the repo-update route — the per-repo half of merge authority.
	// Raised rather than split. The parsing and the whole policy vocabulary live in
	// lib/coding-authority.ts (a split would have put them there anyway); what is left here is the
	// three lines that read one field off a body, which belong with the other fields of the same
	// PUT and would be worse anywhere else.
	"workers/api/src/routes/coding.ts": 1774,
	"workers/api/src/routes/instances.ts": 1696,
	// +5 for #319: the send path now hands the live capture to the consumer alongside the audio
	// key, so the two readings of a turn can be compared on the message. Raised rather than
	// split — the whole change is one `storedDictation` call and the two `onSend` sites that
	// already carried `audioKey`; the decision it makes is pure and lives in machine.ts.
	// +12 for #331/#332: the dictation gate is handed the caller's own echo/paused predicate (so it
	// cannot vouch for a turn made of the agent's TTS), the send gate is handed the bias prompt, and
	// "stop" silences the agent immediately rather than after the teardown await. Raised rather than
	// split — all three are one expression each at a call site that must stay where it is; the
	// decisions themselves are pure and live in gate.ts, audio.ts/prompt.ts and convo.ts.
	"packages/sdk/src/voice/use-voice.ts": 1550,
	// +2 for #319: an import and the one-line swap of the user-bubble body for `SpokenMessage`.
	// The toggle, the divergence count and their prose live in that component, not here.
	// +6 net for #335/#336: `loadMessages` now says whether it is OPENING a conversation or
	// REFRESHING one (the loop watcher's 3s poll is the latter, and scrolling on it is the bug),
	// which costs the flag, the guard and the pinned-flag reset. Paid for in part by the system
	// message's 18-line render block leaving for components/SystemMessage.tsx; the scroll rule
	// and the timestamp arithmetic are pure and live in lib/chatScroll.ts + lib/messageStamp.ts,
	// which is where a split would have put them anyway.
	"store/console/src/pages/InstanceDetail.tsx": 1252,
	// +7 for #338: a deploy notification deep-links to the repo's Builds view, so the tab accepts
	// the repo id and both layouts (solo and multi-repo) open on Builds when it is set. Not split
	// — it is one prop threaded into two `useState` initialisers and two existing call sites.
	"agents/coder/web/src/CodingTab.tsx": 1225,
	"packages/browser-runner/src/runner.ts": 1208,
	// +45 at #263: `probeMcpSurface`, so the connection test can ask about resources and prompts
	// on the one guarded path out of this Worker. Raised rather than split — the network belongs
	// with the rest of the transport, and the reasoning it feeds is pure and lives in
	// mcp-connection.ts, which is where a split would have put it anyway.
	"workers/api/src/lib/connectors/mcp.ts": 1236,
	"workers/mcp/src/index.ts": 1151,
	// +6 for #324: the "Runs on" machine picker had a <label> that named nothing — a label can
	// only name one control and what it labels is a GRID of tiles — so it becomes a named group,
	// which costs a useId, the two lines saying why, and the ignore explaining why not <fieldset>.
	// Not split: three of the six lines are the explanation, and the rest is one hook call.
	"store/console/src/tabs/SettingsTab.tsx": 1155,
	// +6 for #319: the voice turn's live capture is accepted and stored on the message beside
	// `audioKey`. Raised rather than split — it is one field on the record that handleChat
	// already builds, and putting it anywhere else would give it a second retention rule.
	// +19 for #337: the DO task store gets the treatment memory already had — a create-time
	// ceiling, provenance pinned on update (an owner edit takes ownership; nothing on the HTTP
	// path can move it back), and a delete that 404s instead of claiming success on a key that
	// was never there. Raised rather than split: each is two or three lines inside a handler
	// that must stay with its siblings, and every DECISION they encode — staleness, the
	// injection cap, the ceiling, the read shape — lives in lib/agent-tasks.ts, which is where
	// a split would have put them anyway.
	"workers/api/src/agent-do.ts": 1098,
	// +3 for #308: an import plus the two lines saying why three steps unwrap the fence that the
	// connectors now apply at the source. Raised rather than split — the growth is a comment and
	// one import, and splitting the step catalog to absorb three lines would be the tail wagging.
	"workers/api/src/lib/steps.ts": 988,
	// +8 for the #312 stats prompt block. Deliberately not split: the block is two statements
	// and its comment, and it must sit inside the existing config read (`instanceCfg`/`agentCfg`
	// are already in hand) or the prompt costs an extra query per turn. Everything else about
	// stats lives in `lib/stats-*.ts`.
	// +6 more for #318: the recent-work block now also reads the runs this agent DELEGATED, since a
	// supervisor's runs are never on its own instance and the block therefore never fired for one.
	// Not split — the change is one `Promise.all` inside the existing selfModel section, and the
	// rendering it feeds already lives in `lib/work-report.ts`.
	// +26 for #329 (a clock and whose it is) and #340 (the voice channel it does not own). Raised on
	// purpose, and the split it looks like it wants is the one that was already done: every WORD of
	// both lives in `lib/agent-clock.ts` and `lib/agent-style-prompt.ts`, where a unit test can
	// assemble and adjudicate it. What is left here is what only this function can do — one field on
	// the config join it already performs, the turn's instant, and two `systemPrompt +=` lines. Moving
	// those would put a read next to nothing that reads it.
	"workers/api/src/agent-think.ts": 851,
	"workers/api/src/routes/instances-runtime.ts": 849,
	"workers/api/src/lib/triggers.ts": 838,
	"packages/browser-runner/src/coding/headless.ts": 819,
	// +22 at #263: the two read-surface probes and their gate lookup on /mcp/test.
	"workers/api/src/routes/tools.ts": 833,
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
