    // ── Gemini Live voice engine for hands-off mode ──────────────────────────
    // Full-duplex WebSocket to Google's Gemini Live API: captures mic audio,
    // sends as base64 PCM16 16kHz, receives audio/text responses.

    class GeminiLiveVoice {
      constructor(apiKey, opts = {}) {
        this.apiKey = apiKey;
        this.model = opts.model || 'gemini-2.0-flash-exp';
        this.systemPrompt = opts.systemPrompt || '';
        this.onTranscript = opts.onTranscript || (() => {});
        this.onStatusChange = opts.onStatusChange || (() => {});
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
        const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(this.apiKey)}`;
        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
          this.connected = true;
          this.onStatusChange('connected');
          // Send setup message
          this.ws.send(JSON.stringify({
            setup: {
              model: `models/${this.model}`,
              generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                  voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } },
                },
              },
              systemInstruction: {
                parts: [{ text: this.systemPrompt || 'You are a helpful coding assistant. Keep responses concise.' }],
              },
            },
          }));
          this.startMic();
        };

        this.ws.onmessage = (event) => {
          let msg;
          try {
            if (typeof event.data === 'string') {
              msg = JSON.parse(event.data);
            } else {
              return; // binary — handle if needed
            }
          } catch { return; }
          this.handleMessage(msg);
        };

        this.ws.onclose = () => {
          this.connected = false;
          this.onStatusChange('disconnected');
          this.stopMic();
        };

        this.ws.onerror = () => {
          this.onStatusChange('error');
        };
      }

      handleMessage(msg) {
        if (msg.setupComplete) {
          this.onStatusChange('listening');
          return;
        }

        if (msg.serverContent) {
          const sc = msg.serverContent;
          if (sc.modelTurn?.parts) {
            for (const part of sc.modelTurn.parts) {
              if (part.text) {
                this.onTranscript(part.text, 'assistant');
              }
              if (part.inlineData?.data) {
                this.queueAudio(part.inlineData.data);
                this.onStatusChange('speaking');
              }
            }
          }
          if (sc.turnComplete) {
            setTimeout(() => {
              if (this.connected) this.onStatusChange('listening');
            }, 300);
          }
        }
      }

      // ── Mic capture ─────────────────────────────────────────────────────

      async startMic() {
        try {
          this.audioCtx = new AudioContext({ sampleRate: 16000 });
          this.mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true },
          });

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
            // Send as realtime input
            this.ws?.send(JSON.stringify({
              realtimeInput: {
                mediaChunks: [{
                  mimeType: 'audio/pcm;rate=16000',
                  data: base64,
                }],
              },
            }));
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

      queueAudio(base64Data) {
        const binary = atob(base64Data);
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

        const buffer = this.audioCtx.createBuffer(1, float32.length, 16000);
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
      }

      // ── Send text ───────────────────────────────────────────────────────

      sendText(text) {
        this.ws?.send(JSON.stringify({
          clientContent: {
            turns: [{ role: 'user', parts: [{ text }] }],
            turnComplete: true,
          },
        }));
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
