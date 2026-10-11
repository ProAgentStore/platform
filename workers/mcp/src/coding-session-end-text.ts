// What `coding_session_end` tells its caller (#1015) — kept beside coding-tools.ts, which registers the
// tool, the way coding-reauth-tools.ts is.

/**
 * The API's `POST …/sessions/:sid/end` answer (#1015). Copied, not imported — this Worker cannot import
 * `workers/api` (see this directory's CLAUDE.md); `routes/coding-drive.ts` is the source of truth.
 */
export interface EndSessionResponse {
	ok?: boolean;
	session?: "ended" | "already_ended" | "not_found";
	engineStopped?: boolean | null;
	warning?: string;
	directTurn?:
		| {
				turnId: string;
				released: true;
				queue:
					| { attempted: false; reason: string }
					| { attempted: true; drained: false }
					| { attempted: true; drained: true; entryId: string; started: true; runId: string }
					| { attempted: true; drained: true; entryId: string; started: false; requeued: boolean; error: string };
		  }
		| { turnId: string; released: false; reason: "stop_not_confirmed" | "superseded" | string };
}

/**
 * What a caller is told an end did (#1015): each fact the API reported, in its own sentence, then the
 * API's own answer. It used to say "Session … ended." whatever came back — an already-ended session, a
 * stop no machine confirmed, a kept claim and a queue that started nothing all read as a clean end.
 */
export function endSessionText(sid: string, r: EndSessionResponse): string {
	if (!r.ok || r.session === "not_found") return `Session ${sid} was not found — nothing was ended.\n${JSON.stringify(r)}`;
	const lines = [r.session === "already_ended" ? `Session ${sid} was already ended — this call closed nothing new.` : `Session ${sid} ended.`];
	if (r.engineStopped === true) lines.push("The engine on the machine confirmed it stopped.");
	else if (r.engineStopped === false) lines.push(r.warning ?? "The engine did not confirm it stopped — it may still be running.");
	else lines.push("No machine was connected to tell the engine to stop, so whether it stopped is unknown; if that machine comes back, the process may still be running.");
	const d = r.directTurn;
	if (d && !d.released) {
		lines.push(
			d.reason === "superseded"
				? `The direct-turn claim ${d.turnId} was not released: a newer instruction now holds the session. Nothing was admitted from the queue.`
				: `The direct-turn claim ${d.turnId} was kept, because no machine confirmed the engine stopped. Nothing was admitted from the queue.`,
		);
	} else if (d?.released) {
		lines.push(`The direct-turn claim ${d.turnId} was released.`);
		const q = d.queue;
		if (!q.attempted) lines.push("Another session still owns the repository, so the queue was not drained; it waits for that work.");
		else if (!q.drained) lines.push("Nothing was queued for this repository.");
		else if (q.started) lines.push(`The next queued objective (${q.entryId}) was admitted and started as run ${q.runId}.`);
		else lines.push(`The next queued objective (${q.entryId}) could not be started (${q.error}); it ${q.requeued ? "kept its place in the queue" : "did not keep its place in the queue"}.`);
	}
	return `${lines.join(" ")}\n${JSON.stringify(r)}`;
}
