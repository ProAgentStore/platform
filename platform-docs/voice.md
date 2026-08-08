# Voice & hands-free

Every agent chat surface — the **Assistant** tab and the Coder **Co-pilot** — is fully
voice-capable. The voice stack lives in the SDK (`packages/sdk/src/voice/*`) and is consumed
by both the console and the coder web UI through one `useVoice` hook, so behaviour is identical
across surfaces. The pure pieces (`vad.ts`, `convo.ts`, `config.ts`, `audio.ts`) are unit-tested.

## Interaction modes

One segmented control (icon-only on mobile), derived by the pure `resolveVoiceMode`:

- **Chat** — type and read; no microphone.
- **Tap-to-talk** — tap the chat to record, tap again to send; replies are read aloud. The
  auto end-of-turn detector is intentionally OFF here so it can't cut you off mid-thought.
- **Hands-free** — continuous recognition with automatic end-of-turn, auto-reply, then it
  listens again. **Mute** is a sub-control of this mode.

**Only one hands-free session can be active at a time.** A module-level singleton
(`activeHandsFree`) claims the shared slot on entry and releases it on exit/unmount, so two
open instances can't both hold the mic.

## Speech-to-text

Two STT modes (Settings → Speech recognition):

- **Dictation** — the browser's Web Speech API (real-time, less accurate).
- **Whisper ("Smart AI")** — OpenAI via the BYOK key-proxy. The default model is the
  real-time `gpt-4o-transcribe`, which **streams** partial transcripts over SSE so words land
  as you speak (legacy `whisper-1` is still selectable, without streaming). Sub-0.1s clips are
  dropped before upload; a per-agent vocab-bias prompt nudges domain words.

### Vocabulary — the words you say that get misheard

An agent is biased toward the vocabulary it is FOR: a terminal or coding agent expects
`tmux`, `pane`, `pnpm`, `commit`; an apply agent expects `ATS`, `Greenhouse`, `recruiter`.
The platform also supplies the proper nouns it already knows about your agent — its name, its
attached repos, the agents it delegates to — with no configuration at all.

On top of that you can keep **your own list** (Settings → Voice → *My vocabulary*), at two
scopes that **add together** rather than replace each other:

- **Preferences → Voice** — words that follow you everywhere: your name, your company, your stack.
- **an agent's Settings → Voice** — words that belong to that one agent.

This is the one voice setting where "customise for this agent" means *as well as* and not
*instead of*: a vocabulary is a property of you, so you should never have to re-type your own
name into every agent you own. The panel shows the inherited words as fixed chips beside the box.

The list is used twice, because the two recognisers differ. Smart (AI) recognition accepts a
vocabulary hint, so the words are sent with the audio. Browser dictation cannot be steered at
all — there is no working grammar API — so a finished transcript is instead checked for **near
misses** and corrected to your spelling. That pass is deliberately tight: whole words only,
one or two characters at most, never a word that is close to two of your terms. A mishearing
that is not close to anything you listed is left exactly as it arrived, because rewriting a
word you really said is worse than showing you one you didn't.

Lists are capped (~50 terms). That is not a storage limit: a long bias list biases *worse*, and
each extra term is one more word a near-silent recording can echo back at you.

**Language lock — the agent never assumes your language.** When a transcript's dominant script
differs from the configured voice language, it is treated as a mis-detection: it is dropped
(no send, no reply) and you are nudged to repeat, rather than the agent switching languages on
you. The configured language is authoritative; STT and TTS follow it. Toggle with the
per-instance `confirmLanguage` setting (default on).

**A turn you really spoke is never erased.** Silence and background noise make the transcriber
invent a phrase, so a transcript that comes back as filler is rejected rather than sent — but
"the transcript is noise" and "nothing was said" are different claims. When the live gate heard
real words this turn, the pending bubble stays on screen carrying what was heard, marked *Not
transcribed* with a reason and a **Dismiss**; only a turn nothing vouched for disappears. Either
way the rejection is recorded, so a turn that never became a message still leaves a trace.

## Text-to-speech

Browser `SpeechSynthesis` or OpenAI TTS (voice picker + speed). iOS/Safari require a gesture,
so TTS is primed on the mode-switch tap and resumed before each utterance.

**One voice at a time.** TTS is globally exclusive: whichever `VoiceTts` instance starts
speaking silences all others, so the Assistant and the Co-pilot can never talk over each other.

The **status pill** walks Listening → Transcribing → Working so there's never a silent gap, and
while TTS is speaking the pill reads **"Speaking · tap to stop"** — tapping it stops playback.

## Voice commands

Six spoken commands the app acts on **locally** instead of sending to the agent, plus two
keyword settings that are not commands. Master switch: Settings → Voice → `commandsEnabled`.

| Command | Does | Matched when |
|---|---|---|
| `repeat` | Re-speaks the last reply | not muted |
| `mute` | Closes the mic **and** cancels speech + queue | not muted — **at any moment**, see below |
| `unmute` | Re-opens the mic | **only** while muted |
| `exit` | Leaves voice entirely, back to typing | any time (also while muted) |
| `next` | Moves to the agent asking for you | only where the surface can switch |
| `scrap` | Deletes the last turn | only where the surface can delete, and **only on a final transcript** |

Two settings that are *not* in that table:

- **Stop-speaking keyword** (`stopSpeechKeyword`) — halts TTS. Matched as a **case-insensitive
  substring**, deliberately looser than every command above, and safe only because it is gated on
  the agent actually speaking: there is nothing to interrupt otherwise.
- **Stop words** (`stopWords`) — end-of-turn markers ("over", "send it"). They end a dictation
  turn; they are not commands and are stripped from what is sent.

### How a phrase is matched

- A **single-word** phrase must **be the whole utterance**. "mute" never fires inside "mute the
  alarm", and "what's next?" stays a message.
- A **multi-word** phrase matches the whole utterance *or* a contiguous whole-word run inside it,
  so "okay mute mute now" works. Multi-word phrases are distinctive enough for that to be safe.
- `scrap` is held to whole-utterance matching regardless of length, and is withheld from partial
  transcripts entirely — it is the only destructive word in the vocabulary.

Built-in phrasings exist per language and are scoped to the configured voice language, so an
English agent will not fire on a Chinese phrase. **Words you configure yourself replace the
built-ins for that command** and apply in any language, because you chose them.

> A field left **blank** means *use the built-ins* for the six commands, and *off* for the two
> keyword settings — two conventions on one panel, stated here because the placeholders are the
> only other place they are written down. #385 kept that asymmetry deliberately (changing it would
> have silently removed working commands from everyone who never opened the panel) and fixed the
> defect it caused with a precedence rule instead: see *A phrase you bind is yours* below.

### Mute is available at every moment — [ADR 0001](https://github.com/ProAgentStore/platform/blob/main/docs/adr/0001-mute-is-always-available.md)

This is an **invariant**, not a feature of one code path: in a live voice session you can mute by
voice and by touch while the agent is listening, transcribing, thinking, or **speaking** — and
unmute by voice while muted. Mute silences both directions at once (mic closed, speech cancelled,
queue dropped).

It works during TTS because of a **dedicated always-on control listener** (#153): a lightweight
recognizer, separate from the main pipeline, that runs whenever voice is engaged and the main
recorder is idle — i.e. exactly while the agent talks or thinks, when the main path is capturing
nothing. In Whisper mode the recorder produces nothing until the clip uploads, so the speech gate's
live transcript is scanned for control words over that window instead; between the two, no phase is
a dead zone.

Read ADR 0001 before changing anything on that path. A guard that suppresses speech input while the
agent is speaking looks locally correct and removes the entire capability.

The whole stack is script-aware — the gate, STT, TTS and the commands all work in every supported
language.

**A phrase you bind is yours.** Leaving a command field blank still means "use our built-in
phrasings", but a phrase you have bound to one action is never also read as another: it is
removed from every built-in list before those are matched. Binding the stop-speaking keyword to
`stop stop` used to give that phrase two meanings, chosen by whether TTS happened to be playing —
stop the speech while the agent talked, and *leave voice entirely* when it didn't, because the
built-in exit list owns the same words. The explicit binding now wins in both windows.

**The agent's own voice cannot command it.** The background control listener is the one path that
runs *while* the agent speaks — that is what makes "mute" work during playback — so it cannot
simply ignore what it hears in that window. Instead the bar goes up: while the agent is talking (or
inside its short echo tail) a partial transcript is not judged at all, and a command must be the
whole utterance. So a deliberate "mute mute" still stops it, and the agent saying *"Stop me if this
is wrong"* no longer ends your session on the word "stop".

**Hands-free says why it stopped.** If the recogniser dies immediately several times in a row — mic
permission revoked mid-session, another tab or app taking the device, the OS suspending it — the
session gives up rather than spinning in a restart loop. It now says so, with what to try, and
leaves the message up until you act; the give-up is also recorded in the durable error log
(`client:voice`), so a device that keeps dropping out is countable rather than anecdotal.

## Where voice settings live

Three levels, resolved server-side (`workers/api/src/lib/preferences.ts`):

```
platform defaults
  └─ users.preferences.voice                    your account default  (Preferences → Voice)
       └─ agent_instances.config.voiceSettings   PRESENT = "customised for this agent"
            └─ a declared `voiceLanguage` setting (language only, resolved live)
```

`GET/PUT /v1/preferences` for the account default; `GET/PUT /v1/instances/:id/voice-settings` for
one agent, whose Settings tab carries the **"Use my defaults / Customise for this agent"** control.
Customising is *instead of* — with one deliberate exception: **vocabulary unions across scopes**
rather than overriding, because your own name is a property of you, not of an agent.

## Hands-free lifecycle

- **One session app-wide.** A module-level singleton claims the slot, so starting hands-free
  anywhere stops any other hands-free already running — two open tabs of the console cannot both
  hold the mic.
- **Between turns** the mic reopens after a short delay, with a listening chime.
- **Failing restarts** — if the recognizer dies within 800ms of starting, four times in a row
  (mic blocked, permission revoked, another app took the device), hands-free gives up rather than
  spinning in a restart loop that would freeze the page. *Today it does so silently — **#387**.*
- **Maximum turn length** — an open mic is force-ended after `maxDictationMs` so it cannot record
  forever. Armed in hands-free only.
- **Screen wake lock** while a session is live (`keepAwake`, default on), so the phone in your
  hand does not sleep mid-conversation.

## Guards

- **Echo** — results are ignored while the agent is speaking and for ~800ms after, so the agent
  cannot transcribe itself and reply to nothing. Applied on the main path and on the gate scan.
  *Not* applied to the control path, which is why the agent's own voice can currently issue a
  command — **#386**, to be fixed without breaking ADR 0001.
- **Paused** — a turn already in flight, or teardown in progress, does not accept new input. Speech
  captured *before* the pause began is still the user's, and survives.
- **Language lock** — see above.

## Tunables

Every value is clamped server-side and in the SDK, so a bad stored setting cannot break a session.

| Setting | Range | Default |
|---|---|---|
| `silenceMs` (end-of-turn pause) | 500 – 6000 | 1500 |
| `maxDictationMs` (max turn) | 10s – 300s | 60s |
| `sensitivity` (mic gate) | 0.4 – 2 | 0.8 |
| `speed` (TTS) | 25 – 400 | 100 |
| `ttsMaxChars` | clamped | provider-safe default |
| `commandsEnabled` / `keepAwake` / `confirmLanguage` | on unless explicitly false | on |

## Known gaps

Recorded here rather than discovered twice:

- **No Web Speech API → no voice control during TTS.** The always-on control listener is built on
  the browser recognizer and returns nothing where the constructor is absent. Where that happens,
  mute-by-voice while the agent speaks is unavailable and only the on-screen control satisfies
  ADR 0001. Any surface shipping hands-free must keep a touch-reachable mute.
- **Commands are judged more strictly while the agent talks.** Fixing #386 without breaking
  ADR 0001 meant raising the bar rather than closing the door: inside TTS and its echo tail a
  partial transcript is not judged at all and a command must be the whole utterance. A deliberate
  "mute mute" still works; a command said *over* the agent in a longer sentence will not.
- **Blank still means two different things** across the panel (see the note under *How a phrase is
  matched*). Deliberate — #385 chose a precedence rule over a semantics change, because flipping it
  would have removed working commands from every user who never opened the panel.

Closed since this page was written: **#385** (precedence), **#386** (self-command), **#387**
(hands-free says why it stopped) — all three are described above as shipped behaviour.

## Recording replay, translation & transliteration

- **Replay** — each voice turn's audio is saved to R2 (`/voice-audio/:turnId`). The speaker
  button on a message replays the original recording (falls back to TTS); cleared with the chat.
  (It is a button, not a tap on the bubble: a double-tap there hijacked double-click-to-select
  and blocked copying the text.)
- **What was heard vs what was sent** — a voice turn is read twice, by browser dictation as you
  speak and then by Whisper on the clip, and the two disagree. When they do, the live capture is
  stored beside the transcript on the message (`dictation`) and the bubble grows a **Show what
  was heard** toggle, plus a count of the words the transcript never carried. Stored only where
  there is something to compare — a typed turn, or one where both readings agree, carries
  nothing and shows no toggle. It is never sent to the model: it is evidence for the reader,
  not context. Same retention as the transcript exactly — it lives ON the message, so clearing
  the chat deletes the dictation, the transcript and the recording together.

  So the three controls on a voice turn read: **speaker** = hear what was said · **toggle** =
  read what was heard · **the bubble** = read what was sent.
- **Under-message translation** (Settings → Translation) — each assistant reply gets a
  lazily-fetched translation in 16 target languages, with an optional textbook-style
  interlinear gloss (e.g. hanzi with pinyin under each word). **Tap any word** to hear just it.
