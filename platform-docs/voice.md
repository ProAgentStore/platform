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

**Language lock — the agent never assumes your language.** When a transcript's dominant script
differs from the configured voice language, it is treated as a mis-detection: it is dropped
(no send, no reply) and you are nudged to repeat, rather than the agent switching languages on
you. The configured language is authoritative; STT and TTS follow it. Toggle with the
per-instance `confirmLanguage` setting (default on).

## Text-to-speech

Browser `SpeechSynthesis` or OpenAI TTS (voice picker + speed). iOS/Safari require a gesture,
so TTS is primed on the mode-switch tap and resumed before each utterance.

**One voice at a time.** TTS is globally exclusive: whichever `VoiceTts` instance starts
speaking silences all others, so the Assistant and the Co-pilot can never talk over each other.

The **status pill** walks Listening → Transcribing → Working so there's never a silent gap, and
while TTS is speaking the pill reads **"Speaking · tap to stop"** — tapping it stops playback.

## Voice commands & global control words

Say **"Repeat"** (or "say again", "pardon", …) to re-speak the last reply; toggle in
Settings → Voice commands (`commandsEnabled`). A configurable **stop-speaking** keyword halts
TTS by voice.

Control words can be set **globally on your profile** (`GET/PUT /v1/profile`, `group:"voice"`:
`voiceRepeatWords` / `voiceMuteWords` / `voiceStopWords` / `voiceStopSpeechKeyword`) so they
apply across every agent; a per-instance voice config can still override them. The whole stack
is script-aware — the gate, STT, TTS, and the "repeat" command all work in every supported
language.

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
