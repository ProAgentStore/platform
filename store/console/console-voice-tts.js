    // ── Text-to-Speech abstraction ─────────────────────────────────────────
    // Three providers, one interface. Used by chat surfaces to speak responses.

    class VoiceTts {
      constructor(provider, opts = {}) {
        this.provider = provider; // 'browser' | 'openai' | 'gemini'
        this.apiKey = opts.apiKey || '';
        this.voice = opts.voice || 'alloy';
        this.speed = opts.speed || 100; // percentage (50-200)
        this._audioCtx = null;
        this.speaking = false;
      }

      /** Speak text. Returns a promise that resolves when done. */
      async speak(text) {
        if (!text?.trim()) return;
        const clean = String(text).replace(/[*_`#>•]/g, '').replace(/\s+/g, ' ').trim().slice(0, 2000);
        if (!clean) return;
        this.speaking = true;
        try {
          if (this.provider === 'openai' && this.apiKey) return await this._speakOpenAI(clean);
          return await this._speakBrowser(clean);
        } finally {
          this.speaking = false;
        }
      }

      /** Stop any ongoing speech. */
      cancel() {
        this.speaking = false;
        if (window.speechSynthesis) speechSynthesis.cancel();
        // OpenAI TTS can't be cancelled mid-stream (it's a single audio buffer)
      }

      // ── Browser SpeechSynthesis (free, robotic) ──────────────────────────

      _speakBrowser(text) {
        return new Promise((resolve) => {
          if (!window.speechSynthesis) { resolve(); return; }
          try {
            speechSynthesis.cancel();
            const u = new SpeechSynthesisUtterance(text);
            u.rate = Math.max(0.5, Math.min(3, this.speed / 100));
            u.onend = resolve;
            u.onerror = resolve;
            speechSynthesis.speak(u);
          } catch { resolve(); }
        });
      }

      // ── OpenAI TTS API (natural voice) ───────────────────────────────────

      async _speakOpenAI(text) {
        try {
          const res = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'tts-1',
              input: text,
              voice: this.voice,
              speed: Math.max(0.25, Math.min(4, this.speed / 100)),
              response_format: 'wav',
            }),
          });
          if (!res.ok) {
            // Fall back to browser TTS
            return this._speakBrowser(text);
          }
          const arrayBuf = await res.arrayBuffer();
          if (!arrayBuf.byteLength) return this._speakBrowser(text);
          if (!this._audioCtx) this._audioCtx = new AudioContext();
          // Resume context if suspended (browsers suspend after inactivity)
          if (this._audioCtx.state === 'suspended') await this._audioCtx.resume();
          const audioBuf = await this._audioCtx.decodeAudioData(arrayBuf.slice(0));
          const source = this._audioCtx.createBufferSource();
          source.buffer = audioBuf;
          source.connect(this._audioCtx.destination);
          await new Promise((resolve) => {
            source.onended = resolve;
            source.onerror = resolve;
            source.start();
          });
        } catch {
          // Fall back to browser
          return this._speakBrowser(text);
        }
      }
    }

    // ── Shared voice config — one place to read settings + fetch key ────────
    // All voice surfaces (Chat, per-repo Agent, hands-off) call this instead
    // of independently reading handsOffVoiceSettings + fetching the API key.
    let _voiceConfigCache = null;
    let _voiceConfigInstanceId = null;

    async function getVoiceConfig() {
      const instId = (typeof currentInstance !== 'undefined' && currentInstance?.id) || null;
      if (_voiceConfigCache && _voiceConfigInstanceId === instId) return _voiceConfigCache;

      // Load voice settings from server if not loaded yet
      let vs = (typeof handsOffVoiceSettings !== 'undefined' && handsOffVoiceSettings) || {};
      if (!vs.provider && instId && typeof api === 'function') {
        try {
          const d = await api(`/v1/instances/${instId}/voice-settings`);
          vs = d.voiceSettings || {};
          if (typeof handsOffVoiceSettings !== 'undefined') Object.assign(handsOffVoiceSettings, vs);
          if (typeof handsOffVoiceProvider !== 'undefined') handsOffVoiceProvider = vs.provider || 'browser';
        } catch {}
      }
      const isApi = (vs.provider || '').includes('openai');
      let apiKey = '';
      if (isApi) {
        try { apiKey = (await api('/v1/keys/openai/reveal')).key || ''; } catch {}
      }
      const useApi = isApi && !!apiKey;
      _voiceConfigCache = {
        sttProvider: useApi ? 'openai' : 'browser',
        ttsProvider: useApi ? 'openai' : 'browser',
        apiKey,
        voice: vs.openai?.voice || 'alloy',
        speed: vs.speed || 100,
        language: vs.language || 'en-US',
      };
      _voiceConfigInstanceId = instId;
      return _voiceConfigCache;
    }

    function invalidateVoiceConfig() { _voiceConfigCache = null; }

    async function createTts() {
      const cfg = await getVoiceConfig();
      return new VoiceTts(cfg.ttsProvider, { apiKey: cfg.apiKey, voice: cfg.voice, speed: cfg.speed });
    }

    async function createStt(opts = {}) {
      const cfg = await getVoiceConfig();
      return new VoiceStt(cfg.sttProvider, { apiKey: cfg.apiKey, language: cfg.language, ...opts });
    }
