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
	// `workers/api/src/routes/coding.ts` was the largest that remained, at 1778 lines and 39
	// routes. #305 split it along the same kind of boundary — coding-repos.ts (what the agent is
	// pointed at), coding-brains.ts (the three routes that call a MODEL), coding-diagnostics.ts
	// (the reconcile-and-explain view), coding-shared.ts (the tenant gate and the four things all
	// four modules need). What is left is the session lifecycle at 684 lines, so its entry is gone
	// rather than lowered. Each sibling is registered from the exact position its block occupied,
	// and coding.contract.test.ts derives the route table, the order and each module's ownership
	// by driving the handlers — the evidence that the split moved no behaviour.
	//
	// 1696 → 853 at #305. Three contiguous route blocks left for sibling modules along the seams
	// the registrations already had — instances-tasks.ts (the board/ticket surface and the
	// instance_runtime_tasks mirror it all reconciles against), instances-chat.ts (the AgentDO
	// message log), instances-knowledge.ts (the subscriber's own KB). All three are under LIMIT,
	// so they get no entry; this one is lowered rather than deleted because what remains —
	// subscribe/cancel, runtime + node binding, voice, settings, trace — is still over it.
	// +33 for #372/#373: the voice-settings response gained two read-only companions to
	// `vocabulary` (the account words this agent unions with, and the ones the platform derived),
	// and GET/PUT/DELETE now build it through one `voiceSettingsBody` instead of three literals —
	// which is a net reduction in the ways those three can disagree. The derivation itself is a
	// separate module (lib/voice-vocabulary.ts) with its own tests; what is here is the wiring.
	"workers/api/src/routes/instances.ts": 886,
	// +5 for #319: the send path now hands the live capture to the consumer alongside the audio
	// key, so the two readings of a turn can be compared on the message. Raised rather than
	// split — the whole change is one `storedDictation` call and the two `onSend` sites that
	// already carried `audioKey`; the decision it makes is pure and lives in machine.ts.
	// +12 for #331/#332: the dictation gate is handed the caller's own echo/paused predicate (so it
	// cannot vouch for a turn made of the agent's TTS), the send gate is handed the bias prompt, and
	// "stop" silences the agent immediately rather than after the teardown await. Raised rather than
	// split — all three are one expression each at a call site that must stay where it is; the
	// decisions themselves are pure and live in gate.ts, audio.ts/prompt.ts and convo.ts.
	// +58 for #342 ("scrap that"), and most of that is prose rather than logic. The code is one
	// option, two refs, one words ref threaded through the five existing matcher call sites, and
	// two dispatch branches. The rest says WHY three of those five call sites deliberately
	// withhold the flag that enables the command: they judge INTERIM transcripts, and a partial of
	// "scrap that idea and let's move on" is momentarily exactly "scrap that". That reasoning has
	// to live at each site it constrains — a reader deleting the "missing" branch is the failure —
	// and the matching rule it depends on is pure and lives in convo.ts.
	// 1608 → 1602 at #305, and the small number is the honest one: this slice moved the last two
	// inline DECISIONS out (voice/turn.ts — what a finished hands-free turn IS, and whether a
	// transcript may be released as a message) and left the sequencing, which is what this file is
	// for. Both chains are order-sensitive and every ordering in them is a bug someone shipped, so
	// what changed is that a unit test can now adjudicate them; the dispatch that replaced each
	// chain is nearly as long as the chain was. `commandStateFor` is the same trade at the five
	// matcher call sites: the interim/final distinction is now stated at each site and enforced on
	// the way in, rather than being an omission plus a paragraph explaining the omission.
	// +7 for #364, and all of it is the note explaining a rename. `interim` became `notice`: it
	// stopped carrying speech at #281 and kept a name that said otherwise, which is how both
	// consumers went on binding it to their composer's `value` for three releases. The rule the
	// rename enforces is pure and lives in voice/composer.ts.
	// +15 for #372/#373: the bias prompt is no longer whatever the consumer passed — the user's
	// vocabulary and the platform's derived terms arrive with the voice config and are joined onto
	// it. One `biasPrompt()` computes the string all three call sites use, because the echo guard
	// (#332) has to compare against the list that was actually SENT. The joining rule is pure and
	// lives in voice/prompt.ts; the ref plumbing is what a hook is for and could not move.
	// +39 for #377, raised late: f38367f grew this file and did not move the pin with it, which
	// is the omission this ratchet exists to make loud. The growth is right and stays. A noise
	// rejection used to `clear`, and three sites decided that on their own; the verdict is now
	// pure (`planNoiseRejection` in voice/turn.ts) and each site spends lines on what a rejection
	// COSTS — keeping the bubble as `failed`, handing the two recover paths to the composer, and
	// a `client:voice` breadcrumb at each, because the defect's worst property was leaving no
	// record anywhere. `gateSnapshot()` is the one extraction: both flags now read together at
	// every decision point instead of separately at each.
	"packages/sdk/src/voice/use-voice.ts": 1663,
	// +2 for #319: an import and the one-line swap of the user-bubble body for `SpokenMessage`.
	// The toggle, the divergence count and their prose live in that component, not here.
	// +6 net for #335/#336: `loadMessages` now says whether it is OPENING a conversation or
	// REFRESHING one (the loop watcher's 3s poll is the latter, and scrolling on it is the bug),
	// which costs the flag, the guard and the pinned-flag reset. Paid for in part by the system
	// message's 18-line render block leaving for components/SystemMessage.tsx; the scroll rule
	// and the timestamp arithmetic are pure and live in lib/chatScroll.ts + lib/messageStamp.ts,
	// which is where a split would have put them anyway.
	// +11 for #342: a per-turn delete button beside the copy button, and the `dropMessages`
	// callback that removes exactly the ids the SERVER reported deleting. Raised rather than
	// split — the button, its confirmation and its request live in components/DeleteTurnButton.tsx,
	// and what a turn DID (the sentence the confirmation is really for) is pure and lives in
	// lib/turnEffects.ts, which is where a split would have put them anyway.
	// +13 more for the voice half of #342: the `onScrap` option and the ref indirection it needs
	// (the handler wants the thread and the delete callback, both defined below the useVoice call
	// — the same shape `voiceRef` already uses here). The staging, the last-turn rule and the
	// quoted confirmation live in lib/deleteTurn.ts + lib/turnEffects.ts.
	// 1276 → 1274 at #305, and the honest reading of that number is that this slice was not about
	// length. Four DECISIONS left for lib/ where a test can reach them — the splat parse
	// (instanceRoute.ts), who narrates the end of a loop run (loopNotices.ts), the `[Context: …]`
	// strip (chatExport.ts) and the composer placeholder (composer.ts) — and the prose that used to
	// stand in for those tests stayed here, next to the call sites it explains.
	// +35 at #365: the composer moved BELOW the thread and is hidden outside text mode. The move
	// itself is free — it is the same JSX in a different order — but three things around it are
	// not. The thread gains a wrapper so the jump button and the voice pill keep resolving
	// `bottom-3` against the thread's bottom edge rather than the composer's; the mic-level meter
	// is rehomed onto the pill, because its old host is exactly what disappears in the modes where
	// it matters; and both the gate and the re-pin need saying out loud, since "only in text mode"
	// taken literally would delete a `recover`ed turn (#175) at the moment it arrives. The rule
	// itself is pure and lives in lib/composer.ts with the tests, which is where a split would
	// have put it anyway.
	// +17 more for #364: the composer stopped displaying voice text at all, so the notice it used
	// to hide inside its own `value` needs somewhere to be — its own line above the box — and the
	// comment beside the binding says which surface is the live one, which is the confusion that
	// let a dead binding survive three releases. The binding rule itself is pure and lives in the
	// SDK (voice/composer.ts), shared with the Coder Co-pilot rather than restated here.
	// +51 at #376: the Stop button gained the state it never had. A loop run has THREE states —
	// running, settling the step it was asked to stop at, and ended — and the middle one was
	// invisible, so a pressed Stop looked for minutes like a button that did nothing. The DECISION
	// is pure and lives in lib/loopStopState.ts with its tests, which is where a split would have
	// put it; what landed here is the state that carries the server's `cancelRequested` into the
	// header (one `useState` written from the poll, the adopt path and the press), two phase→class
	// records, and the comments explaining why the button now refuses a second press rather than
	// escalating to a hard abort.
	"store/console/src/pages/InstanceDetail.tsx": 1377,
	// +7 for #338: a deploy notification deep-links to the repo's Builds view, so the tab accepts
	// the repo id and both layouts (solo and multi-repo) open on Builds when it is set. Not split
	// — it is one prop threaded into two `useState` initialisers and two existing call sites.
	// 1230 → 1196 at #305, and the small number is the honest one: what is left in this file is
	// JSX and fetch, which this repo's own coverage config says is e2e's job. What moved is the
	// DECISIONS — the repo/session status vocabulary the row phrase, the header badge and the
	// terminal poll each reconciled separately (repo-status.ts), what the add-repo box accepted
	// (repo-input.ts), which session opens by itself and which repo a session is in
	// (session-open.ts), and the timeline→conversation mapping that was written out twice
	// verbatim (timeline-chat.ts). Each replaced a prose paragraph with a test that executes it.
	"agents/coder/web/src/CodingTab.tsx": 1196,
	"packages/browser-runner/src/runner.ts": 1208,
	// +45 at #263: `probeMcpSurface`, so the connection test can ask about resources and prompts
	// on the one guarded path out of this Worker. Raised rather than split — the network belongs
	// with the rest of the transport, and the reasoning it feeds is pure and lives in
	// mcp-connection.ts, which is where a split would have put it anyway.
	"workers/api/src/lib/connectors/mcp.ts": 1236,
	// -1 at #325: the JSON-string coercion create_agent and update_agent each had inline moved
	// to `http.ts` as `parseJsonArg`, which is where the two copies could stop disagreeing about
	// what a MALFORMED string means (create silently dropped it, update refused). Pin lowered so
	// the ground is kept, per this ratchet's own rule.
	// +4 at #375, raised late: c9ea1eb grew this file and did not move the pin with it. The
	// growth is four lines of comment and nothing else — the zod enum LOST a member
	// (INSURANCE_QUOTES, which no `[[workflows]]` binding backs) and gained a note naming
	// `agent-workflows.ts` as the canonical table plus the drift test that now holds this mirror
	// equal to it. This worker builds standalone and cannot import the catalog, so the comment is
	// the only thing at this call site that says where the truth lives.
	"workers/mcp/src/index.ts": 1154,
	// +6 for #324: the "Runs on" machine picker had a <label> that named nothing — a label can
	// only name one control and what it labels is a GRID of tiles — so it becomes a named group,
	// which costs a useId, the two lines saying why, and the ignore explaining why not <fieldset>.
	// Not split: three of the six lines are the explanation, and the rest is one hook call.
	// +13 for #351: the write-consent chip on each tool row. The listing said `allowed` and meant
	// two different things, so the row now states the consent verdict beside the switch that reads
	// as its opposite. Raised rather than split — the verdict itself is computed and tested in
	// workers/api/src/lib/instance-tool-policy.ts, and what is here is one pure label function plus
	// the span that renders it, which only means anything next to the row it annotates.
	// +3 more: the write-access checkboxes are built from `per_call` tools as well, so the
	// connector a chip tells you to grant actually has a switch. Three lines, all of them the
	// explanation of why a read-scoped tool belongs in a WRITE list.
	// #357 extracted the Drive/WorkDrive blocks — one <FileConnectorPanel/>, rendered twice —
	// so the tab shrank while gaining the reconnect affordance and the blast-radius line.
	// +2 at #326: the focus re-check listed `instanceId` alongside the `refreshRunner` callback
	// that is already keyed on it, so one id change re-subscribed the listener twice. Removing the
	// redundant dep is one character; the two lines are the note saying why it is not a missing dep.
	// `store/console/src/tabs/SettingsTab.tsx` was 1015 lines. #355 had already moved the ACCOUNT
	// half out (connect/disconnect was never a property of an agent) and left a note saying the
	// shrink was recorded, not banked — the split was still owed. #305 paid it: two blocks with
	// their own data and their own writes left for components/RunnerPanel.tsx (three endpoints, a
	// refresh cycle, the node pin) and components/ToolPermissions.tsx (the tool switches, the
	// write-consent checkboxes and the MCP grants — three views of one allow-list that had drifted
	// apart while spread across the file). Every phrase either renders now comes from a tested
	// module: lib/runnerPanel.ts, lib/toolPolicy.ts and lib/voiceSummary.ts. 629 lines, so its
	// entry is gone rather than lowered — which is what this guard asks for under LIMIT.
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
	// +36 for #342: deleting ONE turn. The handler is the clear-messages handler's shape applied to
	// a span — list, delete the keys, return the audio ids for the route to drop — plus the prose
	// saying which of the three things a delete removes and, more importantly, which it cannot.
	// Raised rather than split: it belongs beside the clear it must not diverge from, and the
	// DECISION it encodes (what a turn IS) is pure and lives in lib/chat-turns.ts.
	"workers/api/src/agent-do.ts": 1134,
	// +3 for #308: an import plus the two lines saying why three steps unwrap the fence that the
	// connectors now apply at the source. Raised rather than split — the growth is a comment and
	// one import, and splitting the step catalog to absorb three lines would be the tail wagging.
	// +2 for #326: fan_out's `concurrency` option is gone (schema property, description clause, and
	// the local that read it — nothing ever used the value), replaced by four lines saying why it
	// must not come back. The knob is the kind of debt the deleted code cannot record: a model that
	// sets it believes it tuned throughput. Net is code removed, prose added.
	"workers/api/src/lib/steps.ts": 990,
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
	// +20 for #330's `## Your Agents` block — the standing direction a Lead holds for each agent it
	// supervises. Raised rather than split, and the split it looks like it wants is again already
	// done: the block's every word is rendered by `lib/agent-direction.ts` and its rows come from
	// `lib/supervision.ts`, both unit-tested. What is left here is the gate (only an agent that
	// declares a supervision tool pays for the read) and one `systemPrompt +=` — and the gate has to
	// be here, next to the capabilities it reads.
	"workers/api/src/agent-think.ts": 871,
	"workers/api/src/routes/instances-runtime.ts": 849,
	// +1 for #344: one import. The board link it builds is now `instanceBoardLink`, because a
	// console link a Worker writes by hand is a link nothing checks against the router — two were
	// found broken that way. The line it replaced was the same length; the import is the cost.
	// +8 at #358 (two imports, one capability lookup, five lines of why): the run_browse skip
	// notification is derived from what the agent DECLARES instead of unconditionally naming
	// `pags up`, which for a cloud-only agent is a command that cannot help. Raised rather than
	// split — the sentences themselves are pure and tested in lib/trigger-capability.ts, so what
	// is left here is the one lookup that feeds them.
	// +6 at #361 (one argument, five lines of why): the skip notice now declares the EVENT it is
	// about — (trigger, offline-or-busy) — so a five-minute cron whose runner stayed offline all
	// afternoon says so once per window instead of once per tick. The key cannot be computed
	// anywhere else: only this call site knows which trigger and which condition, and the whole
	// point of #361's floor is that the caller names its event rather than the layer guessing
	// from the prose.
	"workers/api/src/lib/triggers.ts": 853,
	"packages/browser-runner/src/coding/headless.ts": 819,
	// +22 at #263: the two read-surface probes and their gate lookup on /mcp/test.
	// +6 at #354 (one import, one lookup, three lines of why): the supervision POST now refuses a
	// supervisor whose agent declares no delegation tool, instead of answering 201 for an edge
	// the runtime can never use. Raised rather than split — it belongs with the cycle/tower/
	// fan-out rejections it stands beside, and the RULE it applies is pure and tested in
	// lib/supervision-capability.ts, which is where a split would have put it anyway.
	// +46 at #330: PUT and DELETE for a subordinate's standing direction, and the paragraph saying
	// why they exist at all. Raised rather than split BECAUSE of that paragraph — this pair of
	// handlers is the only place `setBy: "user"` is ever written, which is what stops a prompt
	// injection from becoming a standing instruction, and a reader who finds the routes without
	// finding that sentence will eventually add a third writer. The rules themselves are pure and
	// tested in lib/agent-direction.ts; the store's compare-and-swap is in lib/supervision.ts.
	// +8 at #374: `POST /:id/loop` accepts an optional `repoId`, so the Coding tab's Loop can name
	// the session it is looking at instead of the coding driver taking `repos[0]`. One field, one
	// coercion, and five lines saying why a generic verb carries a driver-specific target — which
	// is the part a reader has to be told, because the obvious reading is that it does not belong
	// here. The choice it feeds (and its two refusals) is pure and tested in lib/loop-drivers.ts.
	"workers/api/src/routes/tools.ts": 893,
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
