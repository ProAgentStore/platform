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
	// +47 for #379/#380, and most of it says WHY rather than doing anything. `/runtime/status` had
	// resolved the pin correctly and then overridden itself: the fallback row's node was fed to
	// `relayConnected` and to `diagnoseAttachment`, so the endpoint answered "Connected." about a
	// machine the pin excludes while every tool call on the same instance answered "no runner". It
	// now derives liveness from the pin-aware resolution alone and, when that fails, names the dead
	// pin AND the machine that is up. `/runner-node` gained the same vocabulary: the picker folds
	// one machine's several hostnames into one tile and reports where a stale pin resolves. Raised
	// rather than split — three of the four blocks are one expression plus its paragraph, and every
	// decision behind them is pure and lives elsewhere with tests (lib/machine-identity.ts,
	// lib/runtime-attachment.ts, lib/runner-client.ts), which is where a split would have put them.
	// +4 for #468, all of it comment: this route is the THIRD construction site for
	// `diagnoseAttachment` and the only one with no adapter in front of it, so the next input the
	// diagnosis grows has to be added here by hand. That is exactly how #468 happened at the other
	// two sites, and the four lines are what a reader needs to not repeat it a fourth time.
	// +29 at #491: two terminal-session routes (GET + PUT) with their inline handlers and the
	// `removeInstanceConfigKey` call — same pattern as runner-node, not splittable into a sub-module
	// for two handlers. Growth is comment + two handler functions; the decision is sessionless.
	"workers/api/src/routes/instances.ts": 981,
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
	// +29 for #385/#386/#387, and none of the three DECIDES anything here. The precedence rule
	// (#385) is one field threaded into the five matcher call sites — the stop-speech keyword is now
	// visible to the matcher, because a phrase the user bound is what has to outrank a built-in — and
	// it is decided in convo.ts's `commandPhrases`. #386 costs the control listener its `isFinal`
	// argument, an echo snapshot read from the existing `readGuard()`, and the paragraph saying why
	// this one listener raises its bar instead of dropping results like its three siblings do: it is
	// the only one that runs while the agent speaks, which is the capability #153 built it for. #387
	// is the largest slice and the whole point of the ticket — a bail used to be three statements
	// that said nothing, and is now a durable `client:voice` row plus a notice that deliberately does
	// not expire; both come out of `planRestartBail` in convo.ts, so what landed here is the dispatch
	// and the reason the notice outlives the ones above it.
	// +64 for #279, and the change is a net simplification wearing extra length. `nextFromCommand`
	// was one callback that both TORE THE SESSION DOWN and told the consumer where to go; it is now
	// `leaveForSwitch` (the teardown, returning the mode to carry) plus two two-line callbacks that
	// name a destination. That seam is what lets a THIRD trigger — the agent-mediated transfer,
	// which arrives on a chat response and so is not a command at all — take the identical path
	// rather than reimplementing the TTS cut, the #175 recovery and the hands-free slot release.
	// The rest is the `back` command threaded through the five existing matcher call sites, with
	// each site saying whether it may judge the word (only a final may) — the same shape `canScrap`
	// already has, and for the same class of reason.
	// +56 for #420, and roughly forty of them are the reasoning rather than the code. The code is:
	// one parameter on `muteFromCommand` (`pendingTurn`), one timestamp ref beside the two this file
	// already keeps, a `mutedRef` check in `maybeSpeakResponse`, and a report on the `ignore` branch.
	// Every DECISION moved OUT — `planMuteTeardown`, `isMutedTurn` and `pendingUtterance` are pure
	// and live in machine.ts, which is why the 800ms lottery is now a table in machine.test.ts
	// instead of a paragraph here. What could not move is the prose saying WHY the two `"send"` call
	// sites differ from the other four: that is #228's carve-out, it is invisible from either site,
	// and a reader tidying them into consistency would delete the fix that made "run the tests, mute"
	// still run the tests. Same for the conditional echo-tail stamp, which looks like a line someone
	// forgot to make unconditional and is the whole of leg 1.
	// +59 for #421 — a watchdog effect, a `retryDictation` callback, and the reasoning for both.
	// Neither could be moved out: a deadline needs a timer and a timer needs the hook. What DID move
	// out is every judgement they make — `transcribingAt` and the `retry` event are in machine.ts,
	// `isRetryableVoiceError` is in convo.ts, and both network deadlines are in stt.ts, so what is
	// left here is scheduling. The prose that stayed is the part a reader would otherwise undo: why
	// the watchdog is set LONGER than the network deadlines (so the specific message wins the race),
	// and why a transcription timeout is exempted from the `isConnectivityError` skip — that helper
	// matches /timed? ?out/, so the one failure this ticket exists to count would have been filtered
	// out by the thing that hides network noise.
	// +31 for #425, and this is the entry where the prose IS the deliverable. The code is four
	// statements in a handler that used to be `() => { /* mic denied — onEnd re-arms */ }`. What
	// the length buys is the reason the two verdicts differ: REPORT covers a missing device because
	// that is diagnostic, STOP RE-ARMING covers only the two codes a browser can produce by
	// refusing — because `audio-capture` can be two recognizers contending for one microphone, and
	// latching on it would disable the always-on control listener, i.e. delete mute-by-voice for
	// the rest of the session. A reader tidying those two conditions into one would cause the ADR
	// 0001 M1 failure this handler was changed to expose. Both predicates are pure and in convo.ts.
	// +19 for #388's last open item — the decision about ADR 0001's known hole. Four lines of code
	// (a latch ref and a notice when `ensureControlStt` returns null) and fifteen of why the OTHER
	// two options lose: a Whisper-based control channel would continuously upload the room's audio
	// to OpenAI on the user's own key so a mute button can be spoken to, and silence leaves a user
	// unable to tell "this browser cannot" from "the app is ignoring me". That belongs at the null
	// check, which is the only place a reader would consider building the fallback.
	// +5 for #458, and four of the five are the comment. The change itself is `onInterim: (text,
	// phrase)` and one identifier swapped at the matcher call — but WHICH argument goes where is
	// the entire fix: the bubble takes the accumulated utterance, and the command scanner must NOT,
	// because a single-word command only fires when it IS the whole transcript, so handing it an
	// accumulator deletes mute-during-capture (#228, ADR 0001 M1). The accumulation itself is a
	// pure reducer in machine.ts (`reduceHeard`) with the gate as its adapter, so what landed here
	// is the wiring and the reason a later tidy-up must not collapse the two arguments into one.
	// +4 for #443: one ref, one assignment, and its paragraph. The five `words` literals gained a
	// field rather than a line each. They are still five literals and that is worth naming — one
	// of them (the control listener's) omits `repeat`, so a user's custom repeat phrasings do not
	// reach the path that runs while the mic is closed. Left exactly as found: it predates this
	// change and fixing it silently inside an unrelated one is how a behaviour change ships with
	// nothing pointing at it.
	// +18 for #457 step 3: one ref, one assignment at the gate's dispatch, one reset, one field on
	// the turn plan — and eleven lines saying that the call site's OWN comment claimed the word was
	// "stripped by finalize" and was wrong for the exact example it names. The fact has nowhere
	// else to live: only this file knows the gate fired, and only `finalize` can act on it. The
	// decision is pure and lives in convo.ts/turn.ts; the wiring is asserted structurally in
	// send-handoff.test.ts, because dropping any one of the three statements leaves the pure tests
	// green and puts the word back in the message.
	// +17 for #469, and the file got SIMPLER: five hand-written copies of the matcher's word set
	// became one assembly in `applyConfig` (net -6 lines of code), plus a paragraph explaining that
	// the copy which omitted `repeat` did not merely lose a command — it un-RESERVED a phrase the
	// user had bound, so "stop" meant repeat everywhere and tore hands-free down on the one listener
	// that runs while the agent speaks. Raised rather than split: the prose is the deliverable, and
	// `use-voice-words.test.ts` now fails if a sixth field is added to only some of the call sites.
	// +44 at #291 (third pass), and 36 of them are comment: the seven `catch {}` sites in this file
	// were the last untriaged block on that issue, and criterion 3 asks each surviving silence to
	// state why it is right. Six are right — `stt.start()` never rejects because both start paths
	// route to `onError`; `tts.ts` reports and falls back before it gives up; the config catch is
	// the revalidate half of stale-while-revalidate. Naming that IS the deliverable, because the
	// obvious "fix" (an error state per swallow) would file the same event twice, less accurately.
	// The seventh was not right and now reports: a failed audio monitor silently disables the VAD,
	// which is survivable only because `maxDictationMs` ends the turn — a mechanism nobody could
	// see from the empty braces.
	"packages/sdk/src/voice/use-voice.ts": 2017,
	// New entry at #385/#386/#387 — 689 → 845, crossing LIMIT, and it is prose that crossed it.
	// This file is the vocabulary and the RULES over it: which phrases are in force for a command,
	// which transcript may be judged for one, what a failing restart loop means. All three tickets
	// are rules of exactly that kind, so the alternative to growing it is a second file that owns
	// half a decision — `commandPhrases` and `matchVoiceCommand` must agree by construction, and
	// `commandStateFor` exists precisely because the interim/final distinction was once spread over
	// five call sites. The added length is the reasoning: why an explicit binding outranks a built-in
	// and what the deliberately-unfixed half of #385 would cost (a backfill, and freezing
	// language-derived words into user config), why the echo bar goes UP for one listener instead of
	// the door closing, and why a bail needs both a notice and a durable row. A split along
	// "commands" / "session control" is available later if this keeps growing; today it would put the
	// restart guard on one side of a line and the thing that reports its failure on the other.
	// +64 for #279 ("go back"), and about fifty of them are the reasoning. The code is one phrase
	// table, one union member, one field, two matcher branches and one derived flag. The prose is
	// why this command takes `scrap`'s whole-utterance/final-only treatment instead of `next`'s:
	// every phrase for it — "go back", "take me back", "previous agent" — is ordinary English in
	// the middle of a sentence, so BOTH of the rules the rest of this file uses fire on ordinary
	// speech, including the whole-utterance rule applied to a partial. That reasoning has to live
	// beside the table it constrains, because the failure it prevents is a reader "fixing" the
	// inconsistency between this command and its neighbour.
	// +23 for #421's `isRetryableVoiceError`, which belongs beside `classifyVoiceError` because it
	// is the same question asked one level further on: that one decides whether to REPORT a failure,
	// this one whether the user should be offered another attempt at it. Splitting them would put
	// two readings of the same error string in two files. Most of the addition is why the refusal
	// check runs FIRST — every one of these strings contains the word "error", so a 4xx would
	// otherwise be read as retryable and charge the user to discover it was not.
	// +36 for #425's two mic-error predicates, which are eight lines of code and thirty of why they
	// are TWO and not one. They sit here beside `classifyVoiceError` because all three read the same
	// error string and answer different questions about it — report? stop retrying? stop re-arming?
	// — and splitting them would put three readings of one vocabulary in three files, which is the
	// drift this file was consolidated to prevent. The reasoning that had to stay is the negative:
	// `audio-capture` is deliberately NOT a permission verdict, because two recognizers contending
	// for one device produce it, and treating it as terminal would silently disable mute-by-voice.
	// +67 for #456, and the split it asks for happened first: `collapseRepeatedRuns` and its thirty
	// lines of reasoning went to normalize.ts, which is where a reader would be tempted to fold the
	// repetition into the SHARED normaliser — and where the reason not to therefore has to be. What
	// stayed is the part that is only meaningful here: `foldedReading` and `boundByUser`, because a
	// FOLDED reading must never outrank an explicit binding. That is not an edge case — without it
	// the fold reopened #385's exact collision (`stopSpeechKeyword: "stop stop"` folds to `"stop"`,
	// which is still a built-in EXIT phrase, so the destructive reading the user never chose comes
	// back through the door the fold just opened), and #385's own tests caught it. `boundByUser` is
	// also what `reservedElsewhere` now delegates to, so the two readings of "the user bound this"
	// cannot drift apart — the consolidation this file's entry keeps being about.
	// +38 for #443, of which the code is TWO lines: an optional `disabled` list on
	// `VoiceCommandWords` and one early return in `commandPhrases`. That is the entire feature,
	// because every path — the matcher, and all three of the splitter's branches — asks that one
	// function for its phrases, so a single empty answer switches a command off everywhere and the
	// two sides cannot disagree about whether a command EXISTS. The rest is the negative: this
	// file's docstring previously RECOMMENDED the blank-means-off backfill that #443 rejects, and
	// leaving that in place would send the next reader down a path measured to be unrepairable —
	// built-ins are resolved here, at match time, against the caller's language, so writing them
	// into a user's config freezes ten languages' worth of data into one.
	// +18 for #457 step 3 — the one signal in this whole area that is KNOWN rather than inferred.
	// If the app muted because of a word, that word WAS a command, so the single-word trailing rule
	// may be relaxed for THAT command and nothing else. The prose is the deliverable: the pass
	// returns `command: null` on purpose, because firing has already happened, and that asymmetry
	// (fire cheaply, strip only on certainty) is the structural point #457 makes — a reader tidying
	// it into "return the command like every other branch" would fire mute twice per turn.
	"packages/sdk/src/voice/convo.ts": 1091,
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
	// +6 at #264: the pending-MCP-input panel is mounted above the thread, with the paragraph
	// saying why it is HERE and not in a settings tab — the pause happens mid-conversation, and a
	// form nobody finds inside the 30-minute deadline is the same as no form. One import, one
	// conditional element; the card, its controls and every rule they follow live in
	// components/McpInputRequests.tsx + lib/mcpInputRequests.ts, which is where a split would
	// have put them anyway.
	// +13 at #378: the shell already polled `/runtime/status` for the header dot but kept only the
	// boolean, so no surface below it could render an offline state and the Terminal tab learned
	// the runner was gone by failing a relay round-trip. What landed is the attachment REASON
	// beside the boolean (one `useState`, written on both branches of the same poll) and the
	// presence object handed to every surface through `SurfaceContext`. Not split: this is the
	// page's existing runner poll gaining one field, and moving the poll out would put the header
	// dot's own data source in another file. The decisions it feeds are in lib/tmuxView.ts.
	// +7 at #389: comments, not code. Three of the seven explain why the chat bubble's Copy button
	// grows its HIT AREA rather than its box, and four explain the same for the 11×11 replay
	// button in the message header — the arithmetic that says a wide overlay on the destructive
	// Delete would swallow a third of Copy is exactly the kind of thing that gets "tidied" away
	// and re-broken. The classes themselves are three words on lines that already existed.
	// +1 at #388: one comment line, above the Mute button, pointing at ADR 0001. The ADR's own
	// enforcement section asks for exactly this — the constraint is not discoverable from the code
	// that would break it, so the pointer has to sit where someone adding a condition would read
	// it. A line of prose bought against a 1,400-line pin, and the cheapest of the three things
	// that keep this invariant true.
	// +37 at #279: the chat response may now carry a destination, and the page acts on it. Three
	// slices — the `onBack` handler (the mirror of `onNext`), reading the destination off the
	// awaited POST, and the switch itself. Not split, and the reason is the guard in
	// lib/transfer.test.ts: the destination must be read in exactly ONE place and that place must
	// be the send path, because a second reader would silently remove the property the whole design
	// rests on. Every decision it makes is pure and lives in lib/transfer.ts with its tests.
	// +4 at #406: a retracted answer must not render identically to a real one. Three of the four
	// lines are the ternary arm that gives a stamped bubble a red edge and the `{m.fabricated && …}`
	// that puts the label above its text; the fourth is the import. The words themselves live in
	// components/FabricatedNotice.tsx, because a message that says "nothing in this reply was
	// fetched" is the kind of sentence that gets softened by whoever edits the file next, and it is
	// easier to see what it says when it is not one line inside a bubble's class expression.
	// +10 for #421: a Retry button beside Dismiss on the failed dictation bubble, and the two lines
	// saying why it is conditional (a 400/401 fails identically and bills the user's own OpenAI key
	// to find that out). Ten lines for a whole recovery affordance, because everything that decides
	// whether it appears is `voice.canRetryDictation`.
	// +20 for #426, and 16 of them are the comment. The code is four things: `pr-12 sm:pr-0` on the
	// two message header rows, a `title`/`data-msg-stamp` on the two stamps, the `stampTitle` +
	// `useAccountTimeZone` imports, and the one line that reads the zone. The prose is the part
	// worth the pin: the padding is a bare number whose correctness comes from `right-8` + a 24px
	// box + `px-3` in three other files, and a reader who cannot see that derivation will "tidy"
	// it back to nothing. The measurement it replaces was 42px of overlap in WebKit.
	// +21 for #428: the "Load older messages" cursor. The state (`olderCursor`), the echo of the
	// server's cursor instead of a self-minted one, the dedup on prepend, and the catch that now
	// SAYS a page failed rather than looking identical to "there is nothing older" — which is how a
	// feature that returned the newest page every time went unnoticed. The rule itself is in
	// lib/messagePaging.ts with its tests; what is here is the three lines of wiring plus the
	// comments naming the UUID cursor that could never have worked.
	// +3 at #492: `isRepo` const beside `isApply`, and `isCoding`+`isRepo` passed in `active.render()`.
	// Both booleans feed the Settings tab's "Where things live" card only; no behaviour change elsewhere.
	// +4 at #291, all prose: the system-message persistence POST stays swallowed, and the note
	// says why — the line is already in `messages` synchronously, so the user has read it, and
	// reporting a failed system message would require emitting a second system message that
	// might equally fail. That recursion is the reason, and it is not visible from the code.
	// +1 at #509: one property. The shell already computes `surfaceCaps` for `visibleSurfaces`;
	// it now also hands it to `render`, so a COMPOSITE surface can ask the registry the same
	// question the registry asked about it. Knowledge was gated as a whole and its sub-tabs were
	// a static array, which is how the Index panel stayed reachable after the Indexing tab was
	// hidden. The seam here is unchanged and still the right one: this file is the shell, and the
	// next split is the chat/voice state it owns inline, not the surface plumbing.
	// 1504 → 1477 at #514: `CopyButton` left this file for `components/MessageActions.tsx`, which
	// is where the message-corner cluster now lives together with the reason there are two layouts
	// of it. Banked rather than left as headroom — the seam named above (this file is the shell)
	// only stays true if the pieces that leave it stay gone.
	// +1 at #366, and it is one `import Button` line. Three controls here stopped spelling their own
	// padding and radius; the JSX came out even, so the whole cost is the import. Raised rather than
	// paid for by collapsing the call sites onto single lines — compressing code to clear a ratchet
	// is the mirror image of lowering a pin to make room for it, and both leave the number honest
	// while making the file worse.
	// +12 at #518, and eleven of them are the paragraph. The code is `setInput((cur) => cur.trim() ?
	// cur : msg)` in the send catch: the composer cleared the text before the POST, so the platform
	// told a voice user to "send the message again" with nothing left to send, and the server-side
	// resume behind it is gated on byte equality with that exact string. The prose has to say why it
	// only fills an EMPTY box and why re-speaking is not a substitute, or the next reader deletes it
	// as a stray restore.
	"store/console/src/pages/InstanceDetail.tsx": 1490,
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
	// +7 at #405: the unusable-repo diagnosis and its remedy, rendered beside the repo row.
	// Raised rather than split — the phrase itself is the server's, the reconciliation that
	// decides when it outranks `active` is already extracted into repo-status.ts (with tests),
	// and what is left here is the JSX that displays it. A split would have moved the seven
	// lines and left the seam in the same place.
	// +15 at #401: the Pulls panel joins the solo tab row (Terminal · Issues · Pulls · Builds) and
	// each repo card. Raised rather than split — what lands here is the tab wiring and the panel's
	// mount; the panel itself is PullsPanel.tsx and every decision it renders (badge set, ordering,
	// attribution) is pure in pulls-view.ts, with tests. A split would have extracted the fifteen
	// lines that are least worth extracting.
	// +3 at #408, all comment: the Fresh button now sends `fresh: true`. Same reason as
	// workers/mcp/src/index.ts above — a default introduced in the API would otherwise have made
	// this button hand back the exact state the user pressed it to escape, silently, and the note
	// is what stops the flag being tidied away as redundant.
	// +68 at #408's second half, and ~50 of it is prose. The `active ? openTerminal : startSession`
	// fork disappeared from four call sites into ONE `openRepoSession`, which also holds the
	// opening state (a spawn takes seconds; silence reads as a hang, #378) and an inline error
	// where an `alert` used to swallow the server's runner diagnosis; and the one-repo surface now
	// opens its own session. Raised rather than split BECAUSE of the paragraphs: what this change
	// removes is a two-verb affordance that three separate earlier tickets (#241, #257, #411)
	// deliberately put there, so a reader who finds the single "Open" button without finding why
	// it is single — a session is a cache, not a thing to manage — will restore the fork as a
	// courtesy. Both DECISIONS are pure and tested in repo-open.ts (which label, and whether the
	// solo surface may auto-open), which is where a split would have put them anyway.
	// +13 for #431, and 11 of the 13 are prose. The solo tab row went icon-only below `sm` by
	// copying the Co-pilot/Terminal toggle 80 lines above it — two attributes, a `<span>` and two
	// responsive classes — plus two `id`s the WebKit guard measures through. Raised rather than
	// split because the prose IS the deliverable, twice over: `title`/`aria-label` look redundant
	// beside a label that is visible on the reviewer's desktop, and `h-6` looks like arbitrary
	// spacing. Deleting the first re-creates the four unlabelled icon buttons #389 removed from
	// this surface; deleting the second drops the buttons to 21px, under the same ticket's 24px
	// floor, because hiding the label takes a 16px line box out of a 13px icon's button. Both
	// numbers are measured in the `#431` block in e2e/console.spec.ts.
	// +7 for #440: this tab now carries the server's own answer to "did that list actually
	// re-check these paths, and if not why not" (`recheck` on `GET …/coding/repos`) and threads it
	// to `ReposList`, plus the callback that refreshes ONE row after an on-demand re-check.
	// Raised rather than split because deriving it here instead would be the bug: the repos
	// route's resolver honours the instance's "Runs on" pin and the runner status dot does not, so
	// a component guessing from `runnerOnline` reports "checked" for a list that checked nothing —
	// which is exactly how a healthy checkout stayed marked broken for five days.
	// +5 for #454, and all five are prose: the fix itself is two utility classes and a `title` on
	// the line that was already there. Raised rather than split because `truncate min-w-0 flex-1
	// basis-0` reads like four ways of saying the same thing, and the one that matters is the least
	// obvious — `basis-0`. Without it a `flex-wrap` row assigns the caption to its own line from its
	// HYPOTHETICAL main size, before anything is asked to shrink, so `truncate` never fires: the
	// header measured 65px with `scrollWidth > clientWidth` FALSE, a live ellipsis doing nothing.
	// Anyone tidying `flex-1 basis-0` away as redundant re-creates the defect, and the comment is
	// the only thing between them and it. The measurements are in the `#431` block in
	// e2e/console.spec.ts, which now asserts the one-line invariant rather than only recording it.
	// +19 for #291: three writes on this tab reported success they had not earned — the work-mode
	// PUT, the session `start` POST and the clear-history DELETE each `catch {}`-ed and left the
	// optimistic UI standing, so the toggle showed a mode the server refused, a session with no
	// Engine looked like an Engine that had not spoken, and an emptied pane meant nothing. What
	// they now need is a revert, an error slot and a system line apiece. The SENTENCES were pulled
	// out to ./coding-write-failures.ts (with tests) precisely so this pin would move as little as
	// possible, which is why it is 19 and not 27; what is left is per-site state and render, and
	// moving that would mean a component whose only job is to hold one string. Raised rather than
	// split because the alternative to these lines is the silence they replace: this tab's whole
	// defect class is that an optimistic update is indistinguishable from a confirmed one, and
	// every line here exists to make one of the three distinguishable.
	// +14 at #291 (second pass), and all fourteen are prose. Three reads on this tab stay
	// swallowed ON PURPOSE — two polls (1.5s terminal, 4.5s summary) and the issue-body
	// enrichment — and the comments say why each is the correct behaviour rather than an
	// oversight: keeping the last good pane IS the truthful response to a dropped poll, since
	// the terminal did not change because we failed to read it. Without the note the obvious
	// "consistency" edit is to give them error states, which would flash faster than they can
	// be read and would blank a live thread. #291's third criterion is exactly this: the
	// remaining silences are only reviewable if each one states its reason.
	// +20 at #291 (third pass), and note it is the OPPOSITE half of the paragraph above. That one
	// records why three POLLS are correctly silent — they re-run in seconds, so an error state
	// would flash faster than it could be read. `loadCoding` is the mount read behind them, and
	// its silence was the harmful kind: repos, sessions and engines all come from that one call,
	// so a dropped request renders a working four-repo agent as one that has never been pointed
	// at a repository, complete with a live "Add a repo" form. The two are not inconsistent —
	// they are the same rule applied to a fallback that can be mistaken for an answer and to one
	// that cannot. Raised rather than split: the added lines are one state slot, one banner and
	// the reason, and the seam this file actually wants (the landing view vs the session view)
	// is #305's, not something to take under a bug fix.
	"agents/coder/web/src/CodingTab.tsx": 1367,
	// +18 for #425: two Chrome launch flags, the args array reformatted one-per-line to fit them,
	// and the paragraph saying why they are a PAIR. `--use-fake-ui-for-media-stream` on its own
	// auto-GRANTS the real microphone to any page the agent drives — strictly worse than the prompt
	// it removes — so the second flag is not belt-and-braces, it is the point. That sentence has to
	// live next to the flags, because removing "the redundant-looking one" is the obvious tidy-up.
	"packages/browser-runner/src/runner.ts": 1226,
	// +45 at #263: `probeMcpSurface`, so the connection test can ask about resources and prompts
	// on the one guarded path out of this Worker. Raised rather than split — the network belongs
	// with the rest of the transport, and the reasoning it feeds is pure and lives in
	// mcp-connection.ts, which is where a split would have put it anyway.
	// +107 at #264, and most of it is prose rather than logic. A call that hits a server→client ask
	// now PAUSES instead of failing: `pauseForUserInput` parks the call and `elicitationRound`
	// bounds how often that may happen. Raised rather than split, because the paragraphs are the
	// point — the header note and the one beside `pauseForUserInput` say why answering an
	// elicitation in band is impossible on this transport (three independent reasons), why the
	// resume is a RETRY through `mcp_call_tool` rather than a direct dispatch (it re-checks #262
	// consent and re-resolves the #286 credential), and why a pause that cannot be completed must
	// fall back to the honest refusal instead of promising a form that never appears. A reader who
	// finds the code without those will eventually "simplify" the fallback away. The decisions
	// themselves are pure and live in lib/mcp-elicitation.ts, and the storage in
	// lib/mcp-input-requests.ts — which is where a split would have put them.
	"workers/api/src/lib/connectors/mcp.ts": 1343,
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
	// +3 at #408, all comment: `coding_session_fresh` now sends `fresh: true`. Raised rather than
	// split because the three lines ARE the change — the POST body gained one field, and the reason
	// is that a policy in another Worker (a new session continues the repo's recent conversation)
	// would otherwise have deleted this tool's entire contract without touching this file. A reader
	// who finds the flag without finding that sentence will drop it as redundant.
	"workers/mcp/src/index.ts": 1157,
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
	// +6 for #279: the chat turn's response now carries the destination the user asked to be moved
	// to. Raised rather than split, and the six lines are five of comment and one of code — the
	// spread onto the existing `json(...)`. The comment is the load-bearing part: it says the field
	// is attached HERE and on no broadcast, no system message and no poll, which is the property
	// that makes a move nobody asked for impossible rather than merely discouraged.
	// +6 for #406, five of them comment. `/messages` now STAMPS an assistant message that wrote its
	// own tool results instead of serving it as an ordinary answer. The prose is the part worth the
	// lines: it says the stamp is computed on every read and never persisted, which is the whole
	// reason it reaches rows written before #395's guard existed — including in a DO that has been
	// asleep since — and it says this route marks rather than redacts, because the user acted on
	// that text and the record of what they acted on is the one thing that must not be edited.
	// +19 for #428, and almost all of it prose. `/messages` now seeks with an exclusive cursor and
	// reports a MEASURED `hasMore`. The rule — the key format and the cursor vocabulary — lives in
	// lib/message-page.ts with its tests, precisely so this file keeps only the wiring; the lines
	// that stayed here are the ones that say WHY, namely that the fabrication stamp (#406) is
	// decided per message and therefore applies to every page, not only the newest one.
	// +22 for #429: `handleChat` submits its turn through a gate, so two turns cannot run against
	// one agent, sample the same run at different instants and contradict each other. Thirteen of
	// the lines are the paragraph explaining that the user message is durable and broadcast BEFORE
	// the gate sees it — the gate decides when an arrival is answered and never whether — because
	// that is the sentence a future reader needs before they are tempted to move the gate earlier.
	// The queue itself is pure and tested in lib/chat-turn-gate.ts.
	// +25 for #442: ~+40 of feature less ~−15 of tidy-up. `runTurn` reads a stored round before
	// thinking and stores one when a turn that ran tools fails, so a retry continues from results
	// already paid for rather than re-fetching them — and where those tools were writes, does not
	// commit the side effect twice. Decisions are pure in lib/resumable-round.ts; the −15 is the
	// fourth copy of one five-field system-message literal collapsing into `systemMessage()`.
	// +6 for #514, four of them comment: the user message and the assistant reply both carry the
	// turn id the caller minted. Raised rather than split — it is one optional field on the two
	// message literals `handleChat`/`runTurn` already build, exactly like `dictation` above, and
	// moving it elsewhere would separate it from the messages it identifies. The lines that matter
	// are the prose: before this the ONLY join from a transcript to its trace was a timestamp, and
	// the trace's `chat.in` timestamp was stamped at the END of the turn (measured 7.8s late).
	// +27 for #518, of which the executable part is one call: `think` now runs through
	// `thinkWithAutoResume`, so a retryable failure that carried a round is retried ONCE from that
	// round instead of being handed to a user who cannot reproduce the sentence it is keyed to. The
	// rest is the `chat.auto_resumed` event (a recovery nobody can count is one nobody trusts) and
	// the paragraph naming why the platform retries rather than the person. The decision, the
	// bound and the consumption are pure and tested in lib/resumable-round.ts — the same split #442
	// took, which is why this raise is wiring and prose rather than logic.
	"workers/api/src/agent-do.ts": 1245,
	// +3 for #308: an import plus the two lines saying why three steps unwrap the fence that the
	// connectors now apply at the source. Raised rather than split — the growth is a comment and
	// one import, and splitting the step catalog to absorb three lines would be the tail wagging.
	// +2 for #326: fan_out's `concurrency` option is gone (schema property, description clause, and
	// the local that read it — nothing ever used the value), replaced by four lines saying why it
	// must not come back. The knob is the kind of debt the deleted code cannot record: a model that
	// sets it believes it tuned throughput. Net is code removed, prose added.
	// +16 for #396: three DECLARATIONS (geocode/fan_out `dispatches`, enrich `dispatchesFromInput`)
	// and the paragraphs saying why each one is where it is. Raised rather than split, and this file
	// is the only correct home: the whole bug was that "what a step dispatches" lived apart from the
	// handler that dispatches it, so the pre-flight read step NAMES while `geocode` quietly needed
	// `http_request`. A separate table would be the same defect one file over. The rule that reads
	// them is pure in lib/pipeline-tool-policy.ts, and step-dispatch.test.ts derives the same table
	// from this source so a declaration cannot be forgotten.
	"workers/api/src/lib/steps.ts": 1006,
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
	// +63 at #395, and the split it looks like it wants is the one that was already done: what a
	// reply CLAIMS, what the turn actually ran, the correction handed back and the answer that
	// replaces a second fabrication are all pure and live in lib/invented-results.ts with their
	// tests. What landed here is the one thing only this function can do — `deliver`, the single
	// exit every model-authored reply now leaves through, closing over the turn's own execution
	// record and the message array a correction round has to be appended to. It is raised rather
	// than split because the prose is the point: a reader who finds the audit without finding "the
	// final answer after the loop was never parsed at all, and that is where three invented GitHub
	// issues reached the user" will eventually restore a raw return. security-invariants.test.ts
	// holds the ground the pin cannot.
	// +21 for #279: a registry tool may now hand back a destination for the CLIENT as well as text
	// for the model, so the loop accumulates the two halves separately and `deliver` — #395's single
	// exit, which is exactly the seam this needed — reads the destination back out. An accumulator
	// rather than a flag, because a transfer resolved in one round must still travel when a later
	// round calls no tools and returns early. The tool result handed on to the model and the
	// `tool_call` broadcast is rebuilt field by field, so a client directive cannot ride out on a
	// push channel. Picking the destination is pure and lives in lib/conversation-transfer.ts.
	// +25 at #397, and it is a NET SIMPLIFICATION of the thing it grew: four hand-written
	// `runUserWorkersAi(env, userId, effectiveModel, …)` argument lists became one `chatComplete`
	// wrapper, so the file has fewer provider calls in it than before, not more. What it gained is
	// the cap they all now name and the `stop_reason` read they all now share — the fact the
	// platform had in the response body and threw away, which is why a Repo Coder reply that
	// stopped mid-`import` was stored and shown as the whole answer. It cannot be split out: the
	// wrapper closes over `effectiveModel`, `userId` and the turn's own truncation flag, and the
	// flag has to be readable at BOTH delivery exits. The decisions that can be pure — the cap, the
	// provider-verdict test, the sentence the user reads — are, in lib/reply-truncation.ts with
	// their tests, and agent-think.test.ts asserts over this source that there is still exactly one
	// call site.
	// +8 at #399 (two imports, one consent read, five lines of why): the connector list states the
	// RESOLVED write consent instead of the rule that a gate exists, which is what made a tmux agent
	// with four granted write tools refuse the work and send its owner to enable a setting that was
	// already on. The rendering — every label, and the one sentence saying what to do when a tool
	// genuinely IS blocked — is pure and lives in lib/connector-tool-prompt.ts with its tests. What
	// is left here is the one thing only this function can do: read the instance's consent rows at
	// the moment the prompt is built, which is exactly what a cache would have got wrong.
	// +50 at #398, and about two thirds of it is prose about a protocol change that is invisible in
	// the diff: a tool result now arrives as the PLATFORM's `tool_result` block on a `user` turn,
	// answering the model's own `tool_use` turn, instead of as an assistant paragraph that narrated
	// them while the `tool_use` turn was dropped entirely. That old shape is the convention #395's
	// fabrication imitated — the model reproduced the format it was shown every turn — so a reader
	// who finds the branch without finding WHY will eventually simplify it back to two string
	// pushes, which is the bug. The decisions are pure and live in lib/anthropic-tool-turns.ts with
	// their tests: which ids must be answered, the turn that answers them, the merge that cannot
	// bury a result, and the pairing that stops an orphan 400ing the whole chat. What is left here
	// is the part only this function can do — recording each call's outcome against its id as the
	// round executes, choosing the branch from whether the completion carried blocks at all, and
	// `proseOnly()` — the provider requires `tools` to be DEFINED whenever the messages contain tool
	// blocks, so the two completions that deliberately send none (the final answer, and #395's
	// correction round) declare them with `tool_choice:"none"` instead. Omitting them is a 400 on
	// the whole turn rather than a worse reply, which is exactly the kind of constraint that has to
	// be written down beside the call that would otherwise look fine.
	// +1 at #416, and the line is an import. The ten-line ternary that rendered a repo's clone status
	// left every state it did not enumerate — `needs_attention`, `unknown` — printing as the raw enum
	// token, so #405's diagnosis ("the configured checkout … is EMPTY") was stored and never said. It
	// is now one call to lib/repo-status-prompt.ts, where the phrase table is `satisfies
	// Record<CloneStatus, string>`: adding a seventh status without giving it prose is a compile
	// error, which is the actual defence — the old chain was type-safe against exactly this leak. The
	// decisions that can be pure all are (the table, the diagnosis budget, the truncation of a
	// runner-supplied error string) with their tests, so this file got smaller in logic and longer by
	// one import.
	// +7 at #406, one of code and one an import. Stored history passes through
	// `redactFabricatedHistory` before it becomes the prompt, because #395's guard protects the turn
	// it is on and a fabrication written before it shipped was still being read back — one turn on
	// the reporting instance restated an invented ticket list as "as I just fetched" fifteen hours
	// later, having run no tools at all. The five comment lines say what is withheld (the model's
	// reading) and what is not (the stored row, which the console still gets), since a future reader
	// finding a redactor on the context path will otherwise assume the transcript was edited.
	// +6 at #427: one import and a five-line note on `record`, the single seam where a tool result
	// re-enters the next round's prompt. The note is the point — the cap sits ABOVE every deliberate
	// per-tool cap, and a reader who does not know that will read it as a policy about context
	// budgets and start lowering it. The logic itself is one call in lib/tool-result-cap.ts.
	// −1 at #453 (`resolveResponseStyle` hoisted above the repo block so `indexedReposPrompt` knows
	// whether plain speech was asked for; the stale comment at the old site went with it) and +10 at
	// #459 — prompt PROSE, not logic: a HONESTY clause covering asserted FAILURE, where everything
	// already there guarded only false success. A live agent called a working run "stalled … nothing
	// I can do" while the engine was mid-edit. A prompt module beside agent-style-prompt.ts is the
	// better home (#315 did this for the capability literals), but that is not a bug fix's business.
	// +37 at #442, WIRING only: the resume option, the seeded dedup/tool-log/round state, the replay
	// of stored rounds into the transcript, and the `resumableNow()` closure both provider-failure
	// exits hand to the error. Every DECISION is pure in lib/resumable-round.ts, where a split would
	// have put them; what is left is closure over this function's own loop state and cannot move.
	// +21 at #482: terminal_send_message and tmux_send_message dispatch paths in the tool loop.
	// Multi-step handler, same closure-over-loop-state argument: the call and the context are one.
	// +8 at #494 — one import and a six-line call site, which is the whole of the change that lives
	// here. `config.githubRepo` had exactly one reader (`instances-deploy.ts`, for the console), so
	// an Operator asked which repository it worked on answered from memory, and answered "was it
	// deployed?" from a scraped terminal pane while GitHub Actions held a green run. Every part
	// that could move did: the wording, the owner's-zone timestamp, the 3s bound on the lookup and
	// the three outcomes it has to keep distinct are all in lib/deployment-prompt.ts with their own
	// tests. What is left is the call, which needs this function's `instanceCfg`, `userId`,
	// `turnStartedAt` and `ownerTimeZone` and so cannot be lifted out with them.
	// +17 at #291 (third pass). The two `catch {}` here were the "2 of 3 are real" the issue's own
	// re-count named, and the fix could not be a log line: omitting a prompt block is not neutral,
	// because the model then answers "I don't see any repositories" — a confident claim about the
	// account produced by a DO read that failed. Both catches now append the block anyway, marked
	// UNAVAILABLE, reusing the exact vocabulary the terminal grounding rules already use for an
	// unreadable pane. Raised rather than split: the added lines are two prompt strings and the
	// reason they are strings, and they need this function's `systemPrompt` accumulator.
	// +14 for #514, seven of them comment: the paragraph naming FEEDBACK as a third destination
	// beside MEMORY and BEHAVIOUR. Raised rather than split, and it sits directly under the
	// MEMORY-vs-BEHAVIOUR paragraph it extends because the two are one table — subject → memory,
	// manner → behaviour, "you got this wrong" → feedback — and separating them is how a reader
	// stops seeing that. Moving prompt prose into a module was considered and rejected for the
	// same reason the block above gives: these lines need this function's `systemPrompt`
	// accumulator, and a paragraph in a helper is a paragraph nobody reads next to its siblings.
	// +8 at #517, of which three are code: `resolveAgentCapabilities` returns WHICH of its two
	// joins matched instead of discarding it, and the second one IS the agent-template surface —
	// where every tool of a connector in `CONNECTOR_CONSTRAINTS` is refused by decision (#441,
	// `docs/capability-constraints.md`), so they are withheld there rather than offered and then
	// explained. A prompt rule had already been tried and measured: 5/5 replies invented a console
	// path before it, 4/14 after, because `listConsents` is keyed by instance id and returns
	// nothing here, so every write tool rendered "consent NOT granted" and CONSENT_RULE licensed
	// the false remedy. Raised rather than split because the three lines ARE the seam: the surface
	// is only knowable where the two queries are, and it has to reach the one `capabilities` object
	// every downstream gate already reads. Everything that can be pure is — the filter, the empty
	// case that must not fall through to FULL, and the sentence that replaces what was withheld —
	// in lib/template-preview-tools.ts with its tests, which pin the no-op for every other agent by
	// reference equality rather than by inspection.
	"workers/api/src/agent-think.ts": 1180,
	// +44 at #379, and roughly two thirds of it is prose. A machine's identity stopped being its
	// hostname: the registration body accepts a stable `machineId` plus the hostnames that machine
	// has worn, the node upsert stores the id (with the COALESCE that stops an OLDER CLI erasing
	// one), and `claimMachineNames` adopts the rows left behind under a dead name — the one thing
	// that migrates a pin already stranded before any of this existed. Raised rather than split
	// because all of it belongs to this module's subject (the runtime tables and the statements
	// that write them); the DECISIONS — what a machine id is, which names are one machine, and
	// what may therefore be claimed — are pure and live in lib/machine-identity.ts with their
	// tests, which is where a split would have put them anyway.
	"workers/api/src/routes/instances-runtime.ts": 893,
	// +1 for #344: one import. The board link it builds is now `instanceBoardLink`, because a
	// console link a Worker writes by hand is a link nothing checks against the router — two were
	// found broken that way. The line it replaced was the same length; the import is the cost.
	// +8 at #358 (two imports, one capability lookup, five lines of why): the run_browse skip
	// notification is derived from what the agent DECLARES instead of unconditionally naming
	// `pags up`, which for a cloud-only agent is a command that cannot help. Raised rather than
	// split — the sentences themselves are pure and tested in lib/trigger-capability.ts, so what
	// is left here is the one lookup that feeds them.
	// `workers/api/src/lib/triggers.ts` was pinned here at 853 until #412 moved the schedule
	// arithmetic — `normalizeSchedule`, `nextRunAt`, `previewRuns`, `applyJitter` and the new
	// `advanceCron` — into `workers/api/src/lib/cron-schedule.ts`. That took it to 771, under the
	// 800-line threshold, so the entry is gone rather than lowered. The split was forced by the
	// ratchet doing its job: #412 needed one more scheduling function, the file had one line of
	// headroom, and "raise the pin" would have meant defending time arithmetic living in a
	// dispatch module. It could not be defended, so it moved.
	// +55 at #391 (a constant, a config field, a timer, and the paragraphs saying why): one-shot
	// turn boundaries moved from three inferred timers to the process's own exit, and the
	// 15-minute backstop had to become an ENFORCED ceiling — a timer that ends the turn — rather
	// than a rule that relabels a live process as idle. Raised rather than split BECAUSE of the
	// prose: the timers looked correct for years, and a reader who finds the new rule without
	// finding "a one-shot engine's exit is the exact boundary, so a quiet timer can only ever fire
	// early" will eventually restore one. The mechanics that could be extracted (the ceiling, the
	// abort note) are four lines each and belong beside the spawn they guard.
	// +12 at #417 (one import, one call, ten lines of why): `settleAct` now takes an unnumbered
	// `pr.open`/`pr.merge` target from the tool_result it already reads the outcome from, so a PR
	// opened with `gh pr create --fill` gets a badge. Eleven of the twelve lines are the doc
	// comment, and it is the point: the scan looks exactly like the temporal pairing
	// `pull-attribution.ts` refuses, and the only thing distinguishing them — that this result is
	// correlated by `tool_use_id`, so it is the command's own answer — lives in that comment.
	// Raised rather than split BECAUSE the mechanics already were: `fillTargetFromResult` and
	// `resultText` are pure, tested, and in engine-acts.ts. What is left here is the one call and
	// the reason a future reader must not "simplify" it into a transcript regex.
	// +31 at #408, and 26 of them are prose. Two additions: a `resumeFrom` config field (the cloud
	// may nominate a PREVIOUS coding-session id whose conversation to adopt, consulted only when
	// this session's own id has no entry) and a `resumedConversation` getter reporting what
	// actually happened. Raised rather than split BECAUSE of the paragraphs. The resume store is
	// four private functions at the bottom of this file keyed by our session id, and that keying is
	// the entire subject of #408 — it meant a reaped session came back cold and silent, while this
	// file's own header says the engine "survives a runner restart", which is true only for the
	// same row. A reader who finds the field without finding why it exists will "simplify" the
	// lookup order, or drop the getter for the cloud's own intent, and the product will start
	// telling users it remembers things it does not. The DECISION — when continuing is still
	// appropriate — is not here at all: it is pure, tested, and in
	// workers/api/src/lib/coding-session-continuity.ts.
	"packages/browser-runner/src/coding/headless.ts": 917,
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
	// +25 at #352 (three imports, a six-line handler, sixteen lines of why): the connector catalog
	// resolved for ONE instance. Raised rather than split, and it belongs here specifically: this
	// file already owns `/tools`, which is the same question asked about the eleven connectors that
	// HAVE tools — putting the tool-less three somewhere else would be the split that let the two
	// answers disagree. The RULE is pure and tested in lib/instance-connector-policy.ts; what is
	// left at this call site is the one thing only a route can do, resolving the instance's allowed
	// tool names from its capabilities and its owner's off-switches.
	// +106 at #264: the two routes that make a paused outbound-MCP call answerable — list the asks,
	// and submit or cancel one. Raised rather than split BECAUSE of the paragraph above them: the
	// resume goes back through `runRegistryTool("mcp_call_tool")` rather than dispatching the stored
	// call directly, and that is the entire security argument for the design — it means a grant
	// revoked, a tool switched off or a credential deleted while the ask sat in the console stops
	// the retry. A reader who finds these routes without that sentence will eventually "optimise"
	// the re-entry away and turn this into a way to spend a permission the owner took back. The
	// rules the handlers apply are pure and tested in lib/mcp-elicitation.ts, and the one-shot claim
	// is in lib/mcp-input-requests.ts.
	// +8 at #381 (one import, one lookup, six lines of why): PUT …/pipelines/:name now refuses a
	// definition naming a tool the agent does not declare. Raised rather than split, and it belongs
	// at this call site specifically: `validatePipeline` is pure and knows only the registry, so it
	// cannot ask WHOSE agent a definition is being attached to — the capability join is the one
	// thing only a route can do. The RULE is pure and tested in lib/tool-refusal.ts, and the
	// whole-definition check in lib/pipeline-tool-policy.ts, which is where a split would have put
	// it anyway; the enforcing gate is in `runRegistryTool`, not here.
	// +2 at #477: `resolveAccountCeilings` imported and called in the loop route so the per-account
	// loop-iterations ceiling is passed to `sanitizeMaxIterations`. One import, one await, one arg.
	"workers/api/src/routes/tools.ts": 1059,
	// First entry at #477: Usage.tsx crossed 800 lines as BudgetPanel expanded to cover per-tree
	// run knobs (perTreeCostMicros, perTreeDelegations, perTreeMaxDepth, loopMaxIterations) and
	// their edit fields. The page is one coherent screen — usage data + the limits that bound it —
	// so splitting it would put the two halves of the same user action in separate files.
	// +12 at #486: BudgetPanel adds an observe-only notice (renders when enforced===false from the
	// new API field), reflecting that daily circuit-breaker ceilings are stored but not yet enforced.
	// +60 at #543: every breakdown row now prints TWO figures — notional value and the charged part
	// of it — so `CostCell` joins `TokenCell`, and the four cards get a stacked column header and
	// one shared legend. The prose and the three-state rule (charged / measured-zero / never
	// measured) are NOT here: they are pure in lib/usageFigures.ts with their own tests, which is
	// what keeps this file to the JSX. The rest is the paragraph on `Breakdown` recording why the
	// three column widths are written out at each call site instead of shared through a constant —
	// `truncation.test.ts` reads them as source text, and a constant hides the width from it, which
	// is a guard defeated silently. The seam if it grows again: BudgetPanel and its three helpers
	// (~370 lines) read a different API and answer a different question, and moving them to their
	// own file would not split the SCREEN, which is what the note above is actually about.
	"store/console/src/pages/Usage.tsx": 922,
	// First entry at #291, crossing 800 by 5 lines. Recorded rather than squeezed, because the
	// alternative on offer was deleting the paragraph that says why the change exists — and the
	// change is the one that stops a dropped GET from arming "Save All Settings" over an empty
	// Personality / Goal / Welcome Message on a PUBLISHED agent. Compressing an explanation to
	// stay under a threshold is how a guard starts producing worse code than it prevents.
	//
	// The seam, when someone takes it (#305): this file is two screens. Everything from
	// `AgentBuilder` down — buildPlan / execute / the plan editor, ~110 lines — is the "describe
	// an agent and have the model scaffold it" wizard, and it shares only `navigate` with the
	// seven-tab editor above it. Splitting there takes this back under LIMIT without a pin.
	"store/console/src/pages/AgentDetail.tsx": 805,
	// First entry at #477: supervision.ts crossed 800 lines before this PR — the ratchet did not
	// catch it because it was not tracked. Adding the entry to record the current state; the right
	// split is the connector-level supervision vs. the agent-direction store, when this file grows
	// again and the split has a natural seam.
	"workers/api/src/lib/connectors/supervision.ts": 867,
	// This file, crossing its own LIMIT at #456 — and it is not an oddity, it is the guard working.
	// A pin entry is REQUIRED to carry the reason its file grew, so this list is an append-only
	// ledger of decisions: it can only get longer, and the one thing it must never do is get shorter
	// by deleting reasons. The entry is the ledger admitting it is now one of the files it is about.
	// The right split, when the next raise makes it worth doing, is the PINS map into its own data
	// module — the ~50 lines of enforcement above and below are stable and are not what is growing.
	// +4 at #442, which is three pin raises' worth of reasons (agent-think, agent-do, and this) —
	// exactly the "can only get longer by adding reasons" growth the paragraph above predicts.
	// +N again at #456/#443, from the same cause and by a different lane on the same day. Two
	// commits raising this one number independently is the clearest evidence yet that the PINS map
	// wants to be its own data module — see the paragraph above for the split when it is worth it.
	// +5 for #468: the two pins above, and the note saying why they moved.
	// +7 for #469 (the pin above and its note).
	// +13 at #477: three new PINS entries (Usage.tsx, supervision.ts, tools.ts raise) + their reasons.
	// +3 at #486: Usage.tsx raise + its note (the BudgetPanel observe-only notice) + this self-ref.
	// +6 at #491+#482: agent-think + instances raises + their notes + this self-ref.
	// +3 at #492: InstanceDetail raise + its note + this self-ref (one extra for the self-ref updating the count).
	// +12 at #291: the CodingTab raise carries an unusually long reason because the triage IS the
	// deliverable on that issue — it has to record which three writes were silent and why the
	// sentences moved to a sibling module rather than the pin moving further. Plus this self-ref.
	// +14 at #291 (second pass): the CodingTab and InstanceDetail raises above, both of which
	// are pure comment prose recording why a swallow is CORRECT — plus this self-ref. The
	// ledger growing to hold "why this silence is right" is the same growth as "why this file
	// is bigger"; both are reasons, which is the only thing this list is allowed to accumulate.
	// +11 at #494: the agent-think raise above, whose reason has to record what DID move out
	// (wording, timestamp, timeout, the three lookup outcomes) so the next reader can tell a
	// six-line call site from a file nobody split — plus this self-ref.
	// +11 more at #291 (third pass): the CodingTab raise above and its reason.
	// +18 more at #291 (third pass): the use-voice and agent-think raises above, and their reasons.
	// +12 at #291 (third pass): AgentDetail's FIRST entry above, whose reason has to carry both the
	// decision (3 lines over, recorded rather than squeezed) and the seam the next person should
	// take — plus this self-ref. Naming the seam is the part that stops a pin from becoming
	// permanent: an entry that says only "it got bigger" is a number, and this list is a ledger.
	// +7 at #509: the InstanceDetail raise above, whose reason has to say why a one-property
	// growth was recorded rather than squeezed out — plus this self-ref.
	// +8 at #514: the agent-do raise above (a trace id on both messages of a turn) and its reason,
	// plus this self-ref.
	// +6 more at #514: the InstanceDetail entry above is now a LOWERING with its reason, banking
	// the lines `CopyButton` took with it — plus this self-ref.
	// +9 more at #514: the agent-think raise above (the FEEDBACK paragraph) and its reason, plus
	// this self-ref.
	// +8 at #366: the InstanceDetail raise above is ONE line of code (an import), and its reason is
	// longer than the growth it explains — because the interesting part is what was refused, not
	// what was added: collapsing three call sites onto single lines would have cleared the ratchet
	// and made the file worse. Plus this self-ref.
	// +15 at #517: the agent-think raise above — three lines of code that carry WHICH join matched
	// out of `resolveAgentCapabilities` — and a reason longer than the growth, because the part
	// worth reading is the measurement that rejected the cheaper fix. Plus this self-ref.
	// +15 at #518: the agent-do and InstanceDetail raises above — one is a call, one is a line — and
	// both reasons are mostly about a user who speaks rather than types, because that is the fact
	// that turned #442's stored round into a feature nobody could reach. Plus this self-ref.
	// +12 at #543: the Usage.tsx raise above, whose reason names the seam (BudgetPanel) so the next
	// raise has a cheaper option than this one. Plus this self-ref.
	"scripts/check-file-size.mjs": 1055,
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
