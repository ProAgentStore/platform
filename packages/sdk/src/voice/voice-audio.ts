import { API, getToken, reportClientError } from "../client.js";

/**
 * Save a voice turn's audio to R2 so it can be replayed (double-tap the message).
 *
 * Fire-and-forget by contract: a failure means that turn has no replay, never a broken
 * send. The message itself has already gone out by the time this runs — see `emitSend`,
 * which mints the turn id, sends the text, and only then kicks this off.
 *
 * Lifted out of `use-voice.ts` because it depends on nothing in the hook: three primitives
 * in, no refs, no React. Its retry/skip rules are the only real branching in it, and they
 * were untested while it lived inline — `voice-audio.test.ts` covers them now.
 */
export async function uploadVoiceAudio(instanceId: string, turnId: string, blob: Blob): Promise<void> {
	// NOTE: no `keepalive` — it caps the body at 64KB, but a voice recording is far
	// bigger, so keepalive made the PUT fail outright. Retry a few times so a transient
	// connection drop (common on mobile) doesn't lose the recording.
	// Mirror the server's guards so a doomed upload is skipped with a SPECIFIC log line
	// instead of a bare 400 (the log's "HTTP 400" entries were undiagnosable).
	if (!blob.size) {
		reportClientError("voice-audio", "not saved: empty recording blob");
		return;
	}
	if (blob.size > 5 * 1024 * 1024) {
		reportClientError("voice-audio", `not saved: recording too large (${(blob.size / 1024 / 1024).toFixed(1)}MB > 5MB cap)`);
		return;
	}
	const url = `${API}/v1/instances/${instanceId}/voice-audio/${turnId}`;
	let lastErr = "";
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const res = await fetch(url, {
				method: "PUT",
				headers: { Authorization: `Bearer ${getToken() ?? ""}`, "Content-Type": blob.type || "audio/webm" },
				body: blob,
			});
			if (res.ok) return;
			// Keep the server's reason — "HTTP 400" alone is undiagnosable in the log.
			const detail = await res.text().catch(() => "");
			lastErr = `HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`;
			if (res.status < 500) break; // 4xx won't succeed on retry
		} catch (e) {
			lastErr = e instanceof Error ? e.message : String(e);
		}
		await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
	}
	reportClientError("voice-audio", `save failed after retries: ${lastErr}`);
}
