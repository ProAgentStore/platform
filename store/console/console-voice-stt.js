    // ── Speech-to-Text abstraction ──────────────────────────────────────────
    // Three providers, one interface. Used by chat input bars + continuous mode.

    class VoiceStt {
      constructor(provider, opts = {}) {
        this.provider = provider; // 'browser' | 'openai' | 'gemini'
        this.apiKey = opts.apiKey || '';
        this.language = opts.language || 'en-US';
        this.onResult = opts.onResult || (() => {}); // (text, isFinal) => {}
        this.onError = opts.onError || (() => {});
        this.onEnd = opts.onEnd || (() => {});
        this._rec = null;
        this._mediaRec = null;
        this._stream = null;
        this.listening = false;
      }

      /** Start listening. For browser: continuous. For API providers: records then transcribes. */
      async start() {
        if (this.listening) return;
        this.listening = true;
        if (this.provider === 'browser') return this._startBrowser();
        return this._startRecording();
      }

      /** Stop listening and finalize. */
      stop() {
        this.listening = false;
        if (this._rec) { try { this._rec.stop(); } catch {} this._rec = null; }
        if (this._mediaRec) { try { this._mediaRec.stop(); } catch {} }
        if (this._stream) { this._stream.getTracks().forEach(t => t.stop()); this._stream = null; }
      }

      // ── Browser Web Speech API (free, continuous) ────────────────────────

      _startBrowser() {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) { this.onError('Speech recognition not supported in this browser'); this.listening = false; return; }
        const rec = new SR();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = this.language;
        rec.onresult = (e) => {
          let interim = '', final = '';
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const t = e.results[i][0].transcript;
            if (e.results[i].isFinal) final += t; else interim += t;
          }
          if (final) this.onResult(final.trim(), true);
          else if (interim) this.onResult(interim.trim(), false);
        };
        rec.onerror = (e) => { if (e.error !== 'no-speech') this.onError(e.error); };
        rec.onend = () => {
          // Chrome ends continuous sessions periodically — restart if still listening
          if (this.listening) { try { rec.start(); } catch {} }
          else this.onEnd();
        };
        this._rec = rec;
        try { rec.start(); } catch (e) { this.onError(e.message); this.listening = false; }
      }

      // ── API-based: record audio blob, then POST to Whisper/Gemini ────────

      async _startRecording() {
        try {
          this._stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const chunks = [];
          const mediaRec = new MediaRecorder(this._stream, { mimeType: 'audio/webm;codecs=opus' });
          mediaRec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
          mediaRec.onstop = async () => {
            this._stream?.getTracks().forEach(t => t.stop());
            this._stream = null;
            if (!chunks.length) { this.onEnd(); return; }
            const blob = new Blob(chunks, { type: 'audio/webm' });
            await this._transcribe(blob);
            this.onEnd();
          };
          this._mediaRec = mediaRec;
          mediaRec.start();
        } catch (e) {
          this.onError('Mic access denied: ' + e.message);
          this.listening = false;
        }
      }

      async _transcribe(blob) {
        if (this.provider === 'openai') return this._transcribeWhisper(blob);
        // Gemini STT would go here; for now fall back to Whisper
        return this._transcribeWhisper(blob);
      }

      async _transcribeWhisper(blob) {
        if (!this.apiKey) { this.onError('OpenAI API key required for Whisper STT'); return; }
        const form = new FormData();
        form.append('file', blob, 'audio.webm');
        form.append('model', 'whisper-1');
        form.append('language', this.language.slice(0, 2));
        try {
          const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.apiKey}` },
            body: form,
          });
          if (!res.ok) { this.onError(`Whisper error: ${res.status}`); return; }
          const data = await res.json();
          if (data.text?.trim()) this.onResult(data.text.trim(), true);
        } catch (e) {
          this.onError('Whisper failed: ' + e.message);
        }
      }
    }
