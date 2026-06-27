# Voice as Chat I/O — Integration Plan

## Current State (wrong)

- Chat tab: uses AgentDO `/instances/:id/chat` — typed messages only
- Co-pilot (per-repo): uses `/coding/sessions/:id/explain` — typed, separate history
- Overseer: uses `/coding/overseer` — typed, ephemeral (no history)
- Hands-off voice: standalone OpenAI Realtime loop, bypasses all chat backends
- Voice and text are completely disconnected

## Target State

Voice is an I/O mode on any chat surface. One conversation, two input methods.

### Chat Surfaces

| Surface | Scope | Backend | History | Context |
|---|---|---|---|---|
| **Chat tab** | Instance-wide | AgentDO `/chat` | Persistent | Agent identity + memory |
| **Per-repo Agent** | One repo | `/explain` | Timeline | Terminal + repo instructions |
| **Overseer** | All repos | `/overseer` | Persistent (new) | All terminals + instructions |

### Voice I/O (applies to any surface)

```
┌─ type ──────┐
│              ├──► active chat backend ──► response ──┬──► text bubble
└─ speak (🎤) ┘                                       └──► TTS (🔊)
```

- **STT providers:** Browser (free) / OpenAI Whisper / Gemini
- **TTS providers:** Browser (free) / OpenAI TTS / Gemini TTS
- **Voice toggle (🎤):** on the chat input bar — mic captures, STT converts, sends as text
- **Auto-speak (🔊):** toggle — speaks every assistant response
- Settings: voice provider, speed, voice/model — in Settings tab

### Why NOT use OpenAI Realtime as the LLM

OpenAI Realtime bundles STT+LLM+TTS in one WebSocket. Tempting, but wrong for us:
1. The AgentDO is the brain — it has memory, tools, guardrails, knowledge base
2. Realtime uses GPT-4o, but users may want Claude (BYOK)
3. The conversation must be persisted in our DB, not OpenAI's session
4. Tool calling (drive_claude, collections, files) only works through our AgentDO

**Use Realtime as STT+TTS only** (or simpler: Whisper REST for STT, OpenAI TTS REST for speech).

## Implementation

### Phase 1: Voice I/O on Chat tab (instance-wide chat)

**Chat input bar** gets two new buttons:
- 🎤 **Dictate** — holds mic, STT → fills input, user hits Send (or auto-send)
- 🔊 **Auto-speak** — toggle, speaks every assistant response via TTS

No new backend changes — uses existing `/instances/:id/chat` endpoint.

STT options:
- `browser`: Web Speech API `SpeechRecognition` (free, works in Chrome)
- `openai`: POST to OpenAI Whisper API (`/v1/audio/transcriptions`)
- `gemini`: Google Speech-to-Text

TTS options:
- `browser`: `SpeechSynthesisUtterance` (free, robotic)
- `openai`: POST to OpenAI TTS API (`/v1/audio/speech`) → play audio
- `gemini`: Google TTS

### Phase 2: Voice I/O on per-repo Agent view

Same 🎤/🔊 buttons on the co-pilot input bar. Sends to `/explain` endpoint.
Already has terminal context — just adding voice I/O.

### Phase 3: Overseer gets persistent history

Currently `/coding/overseer` is ephemeral — no history. Make it persistent:
- Store Overseer messages in the AgentDO (separate from instance chat)
- The Chat tab for coding agents routes to the Overseer backend
- History loads on tab switch, new messages append

### Phase 4: Continuous voice mode (what hands-off becomes)

"Hands-off" = voice mode ON + auto-speak ON + auto-send ON.
- Mic stays open (continuous recognition)
- Every utterance auto-sends to the active chat
- Every response auto-speaks
- No separate hands-off dialog — it's just three toggles on the chat bar

## Files to create/modify

| File | Change |
|---|---|
| `console-voice-stt.js` | NEW: STT abstraction (browser/whisper/gemini) |
| `console-voice-tts.js` | NEW: TTS abstraction (browser/openai-tts/gemini) |
| `console-voice-openai.js` | DELETE (replaced by stt+tts) |
| `console-voice-gemini.js` | DELETE (replaced by stt+tts) |
| `console-coding-handsoff.js` | Refactor: remove standalone voice loop, add continuous mode |
| `console-instances.js` | Chat tab: add 🎤/🔊 buttons, wire STT/TTS |
| `console-coding-session.js` | Agent view: add 🎤/🔊 buttons, wire STT/TTS |
| `index.html` | Update script tags, add 🎤/🔊 to chat input bars |

## Build Order

1. STT abstraction (`console-voice-stt.js`) — 30 min
2. TTS abstraction (`console-voice-tts.js`) — 30 min
3. Wire to Chat tab input bar — 30 min
4. Wire to per-repo Agent view — 15 min
5. Continuous voice mode (replaces hands-off) — 30 min
6. Delete old OpenAI/Gemini Realtime engines — 10 min
7. Test — 15 min
