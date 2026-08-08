# ADR 0001 — Mute is available at every moment of a voice session

**Status:** Accepted (2026-08-08) · **Owner decision** · Supersedes nothing.

## Context

Hands-free voice is the mode where the user has put the screen down. That is its entire value, and
it is also what makes it uniquely capable of trapping them: an agent that is talking, thinking, or
listening when they want it to stop is a machine that cannot be interrupted by the only channel
they are using.

The product has already been here once. **#153** was filed because control words were checked only
inside the transcription paths, which run only while the main recorder is capturing a user turn. So
"mute" did nothing while the agent was speaking, nothing while it was processing, and nothing while
already muted — *"exactly the moments a user wants to say mute"*. The fix was a dedicated, always-on
control-word recognizer that runs whenever voice is engaged and the main recorder is idle
(`shouldRunControlListener`), i.e. precisely during TTS and thinking.

In 2026-08 a second defect was found in that same listener (**#386**): it is the only speech path
with no echo guard, so the agent's own voice, picked up by the microphone, can issue commands to the
app. The obvious fix — drop control results while the agent is speaking — **would have re-created
#153**, because "while the agent is speaking" is the window mute exists for. The fix was locally
correct, passed review on its own terms, and would have silently removed the feature.

That is the shape this ADR exists to prevent. The constraint is not discoverable from the code being
changed: `isEchoing()` is right there, already tested, already used by three neighbouring paths, and
applying it to the fourth looks like consistency.

## Decision

**Mute and unmute are always reachable. This is an invariant of the product, not a feature of one
code path.**

Concretely, four rules. A change that violates any of them is a regression regardless of what it
fixes.

**M1 — Reachable at every moment.** In a live voice session, the user can mute by **voice** and by
**touch** during every phase: `listening`, `transcribing`, `processing` (the agent is thinking),
`speaking` (the agent is talking), and `muted` (for unmute). No phase may be a dead zone.

**M2 — Immediate and bidirectional.** Mute silences **both directions at once**: it closes the
microphone *and* cancels in-flight speech plus anything queued behind it. Muting an agent that keeps
talking is not mute — and that includes speech that starts *after* the press: mute is a state, not a
one-shot cancel, so a reply arriving while muted is not read aloud (it stays available to "repeat").
Silencing the agent is not the same as silencing the **user**: mute must not destroy the utterance
they had already finished saying. See #420, and M5.

*(Today: `muteFromCommand` stops the recognizer, calls `tts.cancel()`, drops the queue, stops the
level monitor, and resolves the pending capture through `planMuteTeardown`. An earlier version of
this paragraph described that last step as "clears the pending capture" — that was a description of
the #420 defect, not a requirement, and is corrected here.)*

**M3 — No condition may reduce to "not while the agent is speaking".** Guards that suppress speech
input during TTS — echo guards, pause guards, `shouldIgnoreResult` — must **not** be applied
wholesale to the control path. This is the specific rule #386's first draft broke.

**M4 — Unmute is symmetric.** While muted, the only listener running is the control listener, so
unmute must be matched there. A session that can be entered but not left by the same channel is a
trap, and it is the same defect as M1 with the sign flipped.

**M5 — Mute never costs the user their words.** Silencing the agent is not the same as silencing the
**user**. A turn they had already finished speaking survives the press and lands in exactly one
place: the composer, where it is visible, editable and one tap from being sent. Not the agent — mute
is what someone reaches for when something has gone wrong, and firing the interrupted request at the
agent, with spend and a spoken reply, acts on an instruction they withdrew. Not nothing — every other
path in this codebase that destroys a pending utterance hands the words back first, and mute was the
one that deleted them.

The destination must be **explicit**, not derived from timing. Before #420 it was decided by whether
the transcript happened to land inside the 800 ms echo tail: press promptly and the words were
dropped in the pipeline's one unlogged branch, dawdle and they were sent to the agent after the mute,
with nothing on screen either way. Same action, opposite outcomes, chosen by network latency.

The one exception is a mute arriving on the END of a request. "Run the tests, mute" is a request
*plus* a request for quiet, and #228 exists because latching there threw the request away. Those two
call sites say so in as many words (`pendingTurn: "send"`); everywhere else the default is to recover.

### What M3 permits

M3 forbids *disabling* the control path during TTS. It does **not** forbid making that path harder
to fool, and #386 is a real bug that still needs fixing. Permitted techniques, in preference order:

1. **Content comparison** — reject a transcript that matches the utterance currently being spoken.
   This distinguishes the agent's voice from the user's, which is the actual question; time-based
   guards only approximate it. Precedent exists: `isTranscribeBiasEcho` already compares a
   transcript against the prompt that was sent (#332).
2. **A higher bar while speaking, not a closed door** — during TTS, require FINAL results and
   whole-utterance matches, so a deliberate "mute mute" still fires while a partial that momentarily
   reads `stop` inside the agent's sentence does not.
3. **Never a bare single word on a partial while TTS plays.** The narrowest form of (2).

All three keep M1–M4 intact. None of them is "turn the listener off".

### What this does not cover

`exit` and `next` are **not** protected by this ADR. They end or redirect the session rather than
quieting it, and it is legitimate to hold them to a stricter bar (final-only, whole-utterance) or to
require confirmation. Mute is the one that must never be hard to reach, because it is the one a user
reaches for when something has gone wrong.

## Consequences

- **Accepted cost:** the control listener runs during TTS, so mute is exposed to acoustic echo, and
  the mitigation must be content- or precision-based rather than a blanket suppression. That is more
  work than one `if`, and it is the price of the invariant.
- **Accepted cost:** commands judged on partials are cheaper to trigger by accident. M3's permitted
  techniques narrow this for the destructive commands without touching mute.
- **Known hole, deliberately recorded:** the control listener is built on the browser Web Speech API
  (`ensureControlStt` returns `null` where the constructor is absent). Where it is absent, mute by
  **voice** during TTS/thinking is unavailable and only the on-screen control satisfies M1. This is a
  gap in the invariant, not an exception to it. Any surface shipping hands-free must keep a
  touch-reachable mute for exactly this reason.

  **Decided (#388): the hole stays open, and is announced.** Three options were on the table —
  accept it silently and make the touch control unmissable; say so once in the UI; or build a
  non-Web-Speech fallback.

  The fallback is rejected. The only other recogniser available here is Whisper over the key proxy,
  so a control channel built on it means **continuously uploading the room's audio to OpenAI, billed
  to the user's own key, for the whole time voice is engaged** — in order that a mute button can be
  spoken to. That is a privacy and cost trade far larger than the gap it closes, and it would run
  hardest in exactly the phase (the agent talking) where most of what the microphone hears is the
  agent.

  Silence is rejected too, and it was the worst of the three: a user whose configured command words
  simply did nothing had no way to distinguish "this browser cannot do that" from "the app is
  ignoring me". So the absence is now stated once per session, in the same words as a **refused**
  microphone (#425) — because from the user's side those are the same event, and both leave the
  on-screen control carrying the whole invariant.

  A second way into the same hole was found by **#425**: the API is present and the browser
  **refuses** it. That is worse, because the capability disappears while everything looks supported,
  and it used to be completely unlogged. Both paths now report and both tell the user.
- Mute remains a **sub-control of hands-free** in the UI. That is a placement decision, not a
  weakening of M1: the on-screen control is one of the two required channels.

## Enforcement

What should catch a violation, in order of how cheaply it fails:

1. **Unit tests on `matchVoiceCommand`** asserting a mute phrase matches while `ttsSpeaking` is
   true, and an unmute phrase matches while `muted` is true. These are pure and already have a test
   file (`convo.test.ts`).
2. **A test on the control-path dispatcher** asserting that whatever echo/precision logic exists,
   a deliberate mute utterance during TTS still dispatches `mute`. This is the test that would have
   failed #386's first draft.
3. **This ADR, linked from `platform-docs/voice.md`** and from the code comment on the control
   listener, so the constraint is one hop from the place it would be broken.

Tracked in the enforcement issue filed alongside this ADR. Related: **#153** (the feature),
**#386** (the echo defect that must be fixed without breaking it), **#385** (a built-in phrase
outranking a user's own binding), **#387** (hands-free ending with no notice).
