/**
 * Resumable large-file uploader over R2 multipart (the server's
 * /files/multipart/* routes). Real progress (XHR upload events), pause/resume,
 * per-part retry with backoff, and disconnect survival: the session
 * (uploadId + completed part etags) is persisted in localStorage keyed by a
 * file fingerprint, and the multipart session itself lives in R2 until
 * completed/aborted — so a dropped connection or closed tab resumes by
 * re-selecting the same file and re-sending only the missing parts.
 */
import { useCallback, useRef, useState } from "react";
import { API, getToken } from "@proagentstore/sdk/client";

export interface UploadJob {
	localId: string;
	fileName: string;
	size: number;
	/** Bytes confirmed + in-flight progress — drive the progress bar from this. */
	uploaded: number;
	status: "uploading" | "paused" | "error" | "done";
	error?: string;
}

interface Session {
	uploadId: string;
	key: string;
	fileId: string;
	name: string;
	mimeType: string;
	size: number;
	partSize: number;
	/** partNumber → etag for every COMPLETED part. */
	parts: Record<number, string>;
}

const fingerprint = (instanceId: string, f: File) =>
	`pags:upload:${instanceId}:${f.name}:${f.size}:${f.lastModified}`;

const loadSession = (fp: string): Session | null => {
	try { return JSON.parse(localStorage.getItem(fp) || "null") as Session | null; } catch { return null; }
};
const saveSession = (fp: string, s: Session) => { try { localStorage.setItem(fp, JSON.stringify(s)); } catch { /* full */ } };
const clearSession = (fp: string) => { try { localStorage.removeItem(fp); } catch { /* noop */ } };

/** PUT one part via XHR (fetch has no upload-progress events). */
function putPart(
	url: string,
	blob: Blob,
	onProgress: (sent: number) => void,
	register: (xhr: XMLHttpRequest) => void,
): Promise<{ partNumber: number; etag: string }> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		register(xhr);
		xhr.open("PUT", url);
		xhr.setRequestHeader("Authorization", `Bearer ${getToken() ?? ""}`);
		xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
		xhr.onload = () => {
			if (xhr.status >= 200 && xhr.status < 300) {
				try { resolve(JSON.parse(xhr.responseText) as { partNumber: number; etag: string }); }
				catch { reject(new Error("Bad part response")); }
			} else {
				let msg = `HTTP ${xhr.status}`;
				try { msg = (JSON.parse(xhr.responseText) as { error?: string }).error || msg; } catch { /* keep status */ }
				reject(new Error(xhr.status === 409 ? `RESTART:${msg}` : msg));
			}
		};
		xhr.onerror = () => reject(new Error("network error"));
		xhr.onabort = () => reject(new Error("PAUSED"));
		xhr.send(blob);
	});
}

const authedJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
	const res = await fetch(`${API}${path}`, {
		...init,
		headers: { Authorization: `Bearer ${getToken() ?? ""}`, "Content-Type": "application/json", ...(init?.headers || {}) },
	});
	const data = (await res.json().catch(() => ({}))) as T & { error?: string };
	if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
	return data;
};

export function useUploader(instanceId: string | undefined, onDone: () => void) {
	const [jobs, setJobs] = useState<UploadJob[]>([]);
	// Per-job runtime state that must not trigger renders: the File handle (can't be
	// persisted), the in-flight XHR (for pause), and the pause flag the loop checks.
	const runtime = useRef<Map<string, { file: File; xhr: XMLHttpRequest | null; paused: boolean }>>(new Map());

	const patch = useCallback((localId: string, p: Partial<UploadJob>) => {
		setJobs((js) => js.map((j) => (j.localId === localId ? { ...j, ...p } : j)));
	}, []);

	const run = useCallback(async (localId: string) => {
		if (!instanceId) return;
		const rt = runtime.current.get(localId);
		if (!rt) return;
		const { file } = rt;
		const fp = localId;
		try {
			// New session, or resume the persisted one (same fingerprint).
			let session = loadSession(fp);
			if (!session) {
				const created = await authedJson<{ fileId: string; key: string; uploadId: string; partSize: number }>(
					`/v1/instances/${instanceId}/files/multipart/create`,
					{ method: "POST", body: JSON.stringify({ name: file.name, mimeType: file.type, size: file.size }) },
				);
				session = {
					uploadId: created.uploadId,
					key: created.key,
					fileId: created.fileId,
					name: file.name,
					mimeType: file.type || "application/octet-stream",
					size: file.size,
					partSize: created.partSize,
					parts: {},
				};
				saveSession(fp, session);
			}

			const partCount = Math.max(1, Math.ceil(file.size / session.partSize));
			const committedBytes = () =>
				Object.keys(session!.parts).reduce((sum, n) => {
					const i = Number(n);
					return sum + (i === partCount ? file.size - (partCount - 1) * session!.partSize : session!.partSize);
				}, 0);
			patch(localId, { status: "uploading", uploaded: committedBytes(), error: undefined });

			for (let n = 1; n <= partCount; n++) {
				if (session.parts[n]) continue; // already uploaded (resume)
				if (rt.paused) { patch(localId, { status: "paused" }); return; }
				const start = (n - 1) * session.partSize;
				const blob = file.slice(start, Math.min(start + session.partSize, file.size));
				const base = committedBytes();
				const url = `${API}/v1/instances/${instanceId}/files/multipart/${encodeURIComponent(session.uploadId)}/part?partNumber=${n}&key=${encodeURIComponent(session.key)}`;

				let attempt = 0;
				for (;;) {
					try {
						const part = await putPart(url, blob, (sent) => patch(localId, { uploaded: base + sent }), (xhr) => { rt.xhr = xhr; });
						session.parts[part.partNumber] = part.etag;
						saveSession(fp, session);
						patch(localId, { uploaded: committedBytes() });
						break;
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						if (msg === "PAUSED") { patch(localId, { status: "paused", uploaded: committedBytes() }); return; }
						if (msg.startsWith("RESTART:")) {
							// The multipart session expired/was aborted server-side — start over.
							clearSession(fp);
							throw new Error(`${msg.slice(8)} — upload restarted; press Resume`);
						}
						if (++attempt >= 4) throw e;
						await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); // 2s/4s/8s
						if (rt.paused) { patch(localId, { status: "paused", uploaded: committedBytes() }); return; }
					}
				}
			}

			const meta = await authedJson<{ id: string }>(
				`/v1/instances/${instanceId}/files/multipart/${encodeURIComponent(session.uploadId)}/complete`,
				{
					method: "POST",
					body: JSON.stringify({
						key: session.key,
						fileId: session.fileId,
						name: session.name,
						mimeType: session.mimeType,
						parts: Object.entries(session.parts).map(([partNumber, etag]) => ({ partNumber: Number(partNumber), etag })),
					}),
				},
			);
			void meta;
			clearSession(fp);
			patch(localId, { status: "done", uploaded: file.size });
			runtime.current.delete(localId);
			onDone();
			// Tidy the finished row after a beat.
			setTimeout(() => setJobs((js) => js.filter((j) => j.localId !== localId)), 4000);
		} catch (e) {
			patch(localId, { status: "error", error: e instanceof Error ? e.message : String(e) });
		}
	}, [instanceId, onDone, patch]);

	const start = useCallback((file: File) => {
		if (!instanceId) return;
		const localId = fingerprint(instanceId, file);
		runtime.current.set(localId, { file, xhr: null, paused: false });
		setJobs((js) => {
			const existing = js.find((j) => j.localId === localId);
			const job: UploadJob = { localId, fileName: file.name, size: file.size, uploaded: 0, status: "uploading" };
			return existing ? js.map((j) => (j.localId === localId ? job : j)) : [...js, job];
		});
		void run(localId);
	}, [instanceId, run]);

	const pause = useCallback((localId: string) => {
		const rt = runtime.current.get(localId);
		if (!rt) return;
		rt.paused = true;
		rt.xhr?.abort();
	}, []);

	const resume = useCallback((localId: string) => {
		const rt = runtime.current.get(localId);
		if (!rt) return; // file handle lost (reload) — re-select the file to resume
		rt.paused = false;
		void run(localId);
	}, [run]);

	const cancel = useCallback(async (localId: string) => {
		const rt = runtime.current.get(localId);
		if (rt) { rt.paused = true; rt.xhr?.abort(); }
		const session = loadSession(localId);
		if (session && instanceId) {
			// Best-effort: free the stored parts in R2.
			void authedJson(`/v1/instances/${instanceId}/files/multipart/${encodeURIComponent(session.uploadId)}?key=${encodeURIComponent(session.key)}`, { method: "DELETE" }).catch(() => {});
		}
		clearSession(localId);
		runtime.current.delete(localId);
		setJobs((js) => js.filter((j) => j.localId !== localId));
	}, [instanceId]);

	return { jobs, start, pause, resume, cancel };
}
