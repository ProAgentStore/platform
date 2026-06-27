    // ── OpenAI Realtime voice engine for hands-off mode ──────────────────────
    // Full-duplex WebSocket to OpenAI's Realtime API: captures mic audio via
    // AudioWorklet, sends as base64 PCM16 24kHz, receives audio deltas for
    // playback. Server-side VAD handles turn detection.

    class OpenAIRealtimeVoice {
      constructor(apiKey, opts = {}) {
        this.apiKey = apiKey;
        this.model = opts.model || 'gpt-4o-realtime-preview';
        this.voice = opts.voice || 'alloy';
        this.systemPrompt = opts.systemPrompt || '';
        this.onTranscript = opts.onTranscript || (() => {});  // (text, role) => {}
        this.onStatusChange = opts.onStatusChange || (() => {});  // (status) => {}
        this.ws = null;
        this.audioCtx = null;
        this.mediaStream = null;
        this.workletNode = null;
        this.playbackQueue = [];
        this.isPlaying = false;
        this.connected = false;
      }

      async connect() {
        this.onStatusChange('connecting');
        const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.model)}`;
        this.ws = new WebSocket(url, [
          'realtime',
          `openai-insecure-api-key.${this.apiKey}`,
          'openai-beta.realtime-v1',
        ]);

        this.ws.onopen = () => {
          this.connected = true;
          this.onStatusChange('connected');
          // Configure session
          this.send('session.update', {
            session: {
              modalities: ['text', 'audio'],
              instructions: this.systemPrompt || 'You are a helpful coding assistant. Keep responses concise and actionable.',
              voice: this.voice,
              input_audio_format: 'pcm16',
              output_audio_format: 'pcm16',
              input_audio_transcription: { model: 'whisper-1' },
              turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
            },
          });
          this.startMic();
        };

        this.ws.onmessage = (event) => {
          let msg;
          try { msg = JSON.parse(event.data); } catch { return; }
          this.handleMessage(msg);
        };

        this.ws.onclose = (ev) => {
          this.connected = false;
          const reason = ev.code === 1008 ? 'invalid API key' : ev.code === 1006 ? 'connection failed' : ev.reason || '';
          this.onStatusChange(reason ? `disconnected: ${reason}` : 'disconnected');
          this.stopMic();
        };

        this.ws.onerror = (ev) => {
          this.onStatusChange('connection error — check your API key');
        };
      }

      handleMessage(msg) {
        switch (msg.type) {
          case 'session.created':
          case 'session.updated':
            this.onStatusChange('listening');
            break;

          case 'input_audio_buffer.speech_started':
            this.onStatusChange('hearing you');
            // Interrupt any playback
            this.cancelPlayback();
            break;

          case 'input_audio_buffer.speech_stopped':
            this.onStatusChange('thinking');
            break;

          case 'conversation.item.input_audio_transcription.completed':
            if (msg.transcript) this.onTranscript(msg.transcript, 'user');
            break;

          case 'response.audio_transcript.delta':
            // Streaming text of the audio response
            break;

          case 'response.audio_transcript.done':
            if (msg.transcript) this.onTranscript(msg.transcript, 'assistant');
            break;

          case 'response.audio.delta':
            if (msg.delta) this.queueAudio(msg.delta);
            this.onStatusChange('speaking');
            break;

          case 'response.audio.done':
            this.flushPlayback();
            break;

          case 'response.done':
            // After all audio is played, go back to listening
            setTimeout(() => {
              if (this.connected) this.onStatusChange('listening');
            }, 500);
            break;

          case 'error':
            console.error('OpenAI Realtime error:', msg.error);
            this.onStatusChange('error: ' + (msg.error?.message || 'unknown'));
            break;
        }
      }

      send(type, data = {}) {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type, ...data }));
        }
      }

      // ── Mic capture via AudioWorklet ────────────────────────────────────

      async startMic() {
        try {
          this.audioCtx = new AudioContext({ sampleRate: 24000 });
          this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 24000, channelCount: 1, echoCancellation: true } });

          // Create a ScriptProcessor as fallback (AudioWorklet requires a separate file)
          const source = this.audioCtx.createMediaStreamSource(this.mediaStream);
          const processor = this.audioCtx.createScriptProcessor(4096, 1, 1);

          processor.onaudioprocess = (e) => {
            if (!this.connected) return;
            const float32 = e.inputBuffer.getChannelData(0);
            const pcm16 = new Int16Array(float32.length);
            for (let i = 0; i < float32.length; i++) {
              pcm16[i] = Math.max(-32768, Math.min(32767, Math.round(float32[i] * 32767)));
            }
            const bytes = new Uint8Array(pcm16.buffer);
            const base64 = btoa(String.fromCharCode(...bytes));
            this.send('input_audio_buffer.append', { audio: base64 });
          };

          source.connect(processor);
          processor.connect(this.audioCtx.destination);
          this.workletNode = processor;
          this.micSource = source;
        } catch (err) {
          this.onStatusChange('mic error: ' + err.message);
        }
      }

      stopMic() {
        if (this.workletNode) { this.workletNode.disconnect(); this.workletNode = null; }
        if (this.micSource) { this.micSource.disconnect(); this.micSource = null; }
        if (this.mediaStream) { this.mediaStream.getTracks().forEach(t => t.stop()); this.mediaStream = null; }
        if (this.audioCtx) { this.audioCtx.close().catch(() => {}); this.audioCtx = null; }
      }

      // ── Audio playback ──────────────────────────────────────────────────

      queueAudio(base64Delta) {
        const binary = atob(base64Delta);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        this.playbackQueue.push(bytes);
        if (!this.isPlaying) this.playNextChunk();
      }

      playNextChunk() {
        if (!this.playbackQueue.length || !this.audioCtx) {
          this.isPlaying = false;
          return;
        }
        this.isPlaying = true;
        const chunk = this.playbackQueue.shift();
        const pcm16 = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2);
        const float32 = new Float32Array(pcm16.length);
        for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768;

        const buffer = this.audioCtx.createBuffer(1, float32.length, 24000);
        buffer.getChannelData(0).set(float32);
        const source = this.audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.audioCtx.destination);
        source.onended = () => this.playNextChunk();
        source.start();
      }

      cancelPlayback() {
        this.playbackQueue = [];
        this.isPlaying = false;
        // Send cancel to server
        this.send('response.cancel', {});
      }

      flushPlayback() {
        // Let the queue drain naturally
      }

      // ── Send text (for commands/overrides) ──────────────────────────────

      sendText(text) {
        this.send('conversation.item.create', {
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text }],
          },
        });
        this.send('response.create', {});
      }

      // ── Disconnect ──────────────────────────────────────────────────────

      disconnect() {
        this.connected = false;
        this.stopMic();
        this.cancelPlayback();
        if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
        this.onStatusChange('disconnected');
      }
    }
