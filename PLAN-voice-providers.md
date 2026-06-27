# Voice Provider Settings for Hands-off Mode

## Goal

Replace the browser-native Web Speech API (robotic, high latency, no LLM integration) with professional voice AI providers. The user picks a provider in the hands-off settings panel; the system handles STT, LLM routing, and TTS through that provider.

## Providers

| Provider | STT | LLM | TTS | Transport | Latency | Cost/min |
|---|---|---|---|---|---|---|
| **Browser** (current) | Web Speech API | co-pilot HTTP | speechSynthesis | None | 500ms-2s | Free |
| **OpenAI Realtime** | Built-in (Whisper) | GPT-4o | Built-in | WebSocket | 150-300ms | ~$0.01 |
| **Gemini Live** | Built-in | Gemini 2.0 | Built-in | WebSocket | ~300ms | ~$0.008 |

Claude has no voice API — would require Deepgram STT + Claude text + ElevenLabs TTS (3 roundtrips, ~2-4s latency). Not worth it for real-time conversation.

## Architecture

```
User speaks → [Provider] → text/audio response → play back
                  ↓
           Provider-specific:
           - Browser: SpeechRecognition → co-pilot API → speechSynthesis
           - OpenAI:  AudioWorklet → WS → GPT-4o Realtime → audio deltas → play
           - Gemini:  AudioWorklet → WS → Gemini 2.0 → audio chunks → play
```

The voice provider is a **swappable engine** — the hands-off mode logic (repo focus, commands, scope) stays the same, only the STT→LLM→TTS pipeline changes.

## Implementation Plan

### Phase 1: Settings infrastructure

**API: `/v1/instances/:id/voice-settings`** (GET/PUT)
- Stored in `agent_instances.config.voiceSettings`
- Schema:
  ```json
  {
    "provider": "browser" | "openai-realtime" | "gemini-live",
    "openai": { "model": "gpt-4o-realtime-preview", "voice": "alloy" },
    "gemini": { "model": "gemini-2.0-flash-exp" },
    "language": "en-US"
  }
  ```
- No migration needed — config is a JSON column, already flexible

**Console: Voice provider selector in hands-off dialog**
- Dropdown: Browser (free) / OpenAI Realtime / Gemini Live
- Per-provider options (voice, model) shown when selected
- Provider requires API key → check via `/v1/keys/status` and link to Profile

### Phase 2: OpenAI Realtime client (browser)

**New file: `store/console/console-voice-openai.js`** (~400 lines)
- `OpenAIRealtimeVoice` class
- `connect(apiKey, model, voice, systemPrompt)` → opens WS
- Audio capture: `AudioWorklet` → 24kHz PCM16 → base64 → WS
- Audio playback: decode base64 deltas → `AudioContext` → play
- VAD: server-side (OpenAI handles silence detection)
- Interrupt: user speaks while playing → cancel playback, send new input
- Events: `onTranscript(text)`, `onResponse(text)`, `onAudio(chunk)`

**Key**: the WS goes **directly from browser to OpenAI** — no proxy through PAGS. The API key comes from the user's BYOK vault. The system prompt includes the repo context (same as the co-pilot).

### Phase 3: Gemini Live client (browser)

**New file: `store/console/console-voice-gemini.js`** (~350 lines)
- Similar pattern to OpenAI but with Google's Protobuf WS protocol
- `@google/generative-ai` SDK or raw WS
- 16kHz PCM input, audio output via TTS

### Phase 4: Integration with hands-off mode

**Modified: `store/console/console-coding-handsoff.js`**
- `startHandsOff()` reads voice settings, creates the right engine
- Browser engine: current code (unchanged)
- OpenAI engine: `new OpenAIRealtimeVoice(key, model, voice, prompt)`
- Gemini engine: `new GeminiLiveVoice(key, model, prompt)`
- `stopHandsOff()` disconnects the active engine
- `onPhrase(text)` routing stays the same — all engines produce text

### Phase 5: API key proxy (security)

The browser can't hold raw API keys safely. Options:
1. **Direct from browser** — key fetched from `/v1/keys/proxy`, held in JS memory. Simple but key is in browser memory.
2. **Proxy through PAGS** — browser sends audio to PAGS, PAGS forwards to OpenAI with the stored key. More secure but adds latency + cost (CF bandwidth).
3. **Ephemeral token** — OpenAI supports ephemeral tokens via REST → WS. Best security. PAGS issues a short-lived token, browser connects directly.

**Recommendation:** Option 3 (ephemeral token) for OpenAI. PAGS has a `/v1/keys/proxy` already — add a `/v1/voice/token` endpoint that creates an ephemeral OpenAI Realtime session token using the stored API key.

## Files to create/modify

| File | Action | Lines |
|---|---|---|
| `store/console/console-voice-openai.js` | Create | ~400 |
| `store/console/console-voice-gemini.js` | Create | ~350 |
| `store/console/console-coding-handsoff.js` | Modify | ~100 |
| `store/console/index.html` | Add script tags | ~2 |
| `workers/api/src/routes/instances.ts` | Voice settings GET/PUT | ~30 |
| `workers/api/src/routes/keys.ts` | Ephemeral token endpoint | ~40 |

## Build order

1. Voice settings API + UI selector (30 min)
2. OpenAI Realtime browser client (2 hours)
3. Integration with hands-off mode (30 min)
4. Gemini Live browser client (1.5 hours)
5. Testing + polish (30 min)

## Reference

- AIPA OpenAI Realtime: `~/dev/aipa/platform` (Swift, but same WS protocol)
- OpenAI Realtime docs: messages are `session.update`, `input_audio_buffer.append`, `response.create`
- Audio format: PCM16, 24kHz, mono, base64-encoded chunks
- Voices: alloy, ash, ballad, coral, echo, sage, shimmer, verse
