import { join } from "node:path";
import { CrashLog, crashReport, readJsonOrQuarantine, runtimeCrashIdentity, writeJsonAtomic } from "./crash-reports.js";
import { WORKFLOW_DRIVEN_TASKS } from "./task-types.js";
import type { RunnerEvent, RunnerSession, RunnerTask } from "./types.js";

interface StoreFile {
	sessions: RunnerSession[];
	tasks: RunnerTask[];
	events: RunnerEvent[];
	/**
	 * Events dropped off the end of the {@link MAX_EVENTS} buffer, ever (#1087). The buffer is a
	 * window, not a history; this says how much of the history it no longer holds.
	 */
	droppedEvents?: number;
}

/** Events kept in the local store. Older ones are dropped — and counted in `droppedEvents`. */
export const MAX_EVENTS = 500;

function emptyStore(): StoreFile {
	return {
		sessions: [],
		tasks: [],
		events: [],
	};
}

/**
 * The runner's local sessions / tasks / events file.
 *
 * Crash-safe since #1087: every write is atomic (temp file + fsync + rename, `crash-reports.ts`), so
 * a crash mid-write leaves the previous file intact rather than a truncated one; and a file that
 * does not parse is QUARANTINED (moved to `runner-store.json.corrupt-<time>`) and reported in the
 * crash log for delivery to the platform — it used to read as an empty store, and the next write
 * then overwrote the evidence. Limits are those of `writeJsonAtomic`: the write in flight at a hard
 * kill or power loss is lost, never half-applied.
 */
export class RunnerStore {
	private readonly filePath: string;
	private readonly crashLog: CrashLog;

	constructor(dataDir: string) {
		this.filePath = join(dataDir, "runner-store.json");
		this.crashLog = new CrashLog(join(dataDir, "crash-reports.json"), runtimeCrashIdentity());
	}

	/** How many events the buffer has dropped, ever. */
	droppedEventCount(): number {
		return this.read().droppedEvents ?? 0;
	}

	listSessions(): RunnerSession[] {
		return this.read().sessions;
	}

	createSession(): RunnerSession {
		const data = this.read();
		const now = new Date().toISOString();
		const session: RunnerSession = {
			id: `session_${crypto.randomUUID()}`,
			createdAt: now,
			status: "active",
		};
		data.sessions.unshift(session);
		this.write(data);
		return session;
	}

	listTasks(): RunnerTask[] {
		return this.read().tasks;
	}

	getTask(id: string): RunnerTask | null {
		return this.read().tasks.find((task) => task.id === id) || null;
	}

	/**
	 * On process startup, any persisted task still in an in-flight state
	 * (needs_human / running) is orphaned — its live browser page and takeover
	 * session died with the previous process and can't be resumed. Fail them so
	 * they don't linger as stale "Needs you" cards. Returns the count expired.
	 */
	expireInFlightTasks(): number {
		const data = this.read();
		const now = new Date().toISOString();
		let expired = 0;
		for (const task of data.tasks) {
			// Job-application tasks are driven by a DURABLE Cloudflare Workflow, not this
			// runner process — they survive a runner restart (relay reconnect / crash) and
			// the workflow owns their lifecycle. Expiring them here would flip a LIVE apply
			// to "failed", which re-mirrors to the board, resurrects the Retry button, and
			// slips past the API single-flight guard → a second concurrent apply on the one
			// browser page. Mirrors the API carve-out in expireOrphanedRuntimeTasks.
			if (WORKFLOW_DRIVEN_TASKS.has(task.type)) continue;
			if (task.status === "needs_human" || task.status === "running") {
				task.status = "failed";
				task.error =
					"Runner restarted — this paused task was orphaned (its browser session is gone). Re-run it to try again.";
				task.updatedAt = now;
				task.completedAt = now;
				expired += 1;
			}
		}
		if (expired > 0) this.write(data);
		return expired;
	}

	putTask(task: RunnerTask): RunnerTask {
		const data = this.read();
		const index = data.tasks.findIndex((row) => row.id === task.id);
		if (index === -1) data.tasks.unshift(task);
		else data.tasks[index] = task;
		this.write(data);
		return task;
	}

	addEvent(event: Omit<RunnerEvent, "id" | "createdAt">): RunnerEvent {
		const data = this.read();
		const row: RunnerEvent = {
			...event,
			id: `event_${crypto.randomUUID()}`,
			createdAt: new Date().toISOString(),
		};
		data.events.unshift(row);
		if (data.events.length > MAX_EVENTS) {
			data.droppedEvents = (data.droppedEvents ?? 0) + (data.events.length - MAX_EVENTS);
			data.events.length = MAX_EVENTS;
		}
		this.write(data);
		return row;
	}

	listEvents(limit = 100): RunnerEvent[] {
		return this.read().events.slice(0, limit);
	}

	private read(): StoreFile {
		const got = readJsonOrQuarantine<Partial<StoreFile>>(this.filePath);
		if (got.status === "missing") return emptyStore();
		if (got.status === "quarantined") {
			// Evidence, not an empty store: the file is moved aside, the move is reported, and only
			// then does the runner continue on a fresh store.
			const message = `runner store was unreadable and was moved to ${got.quarantinedTo}: ${got.error}`;
			process.stderr.write(`[store] ${message}\n`);
			this.crashLog.record(crashReport({ ...runtimeCrashIdentity(), kind: "store_corrupt", message }));
			return emptyStore();
		}
		const parsed = got.value;
		return {
			sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
			tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
			events: Array.isArray(parsed.events) ? parsed.events : [],
			droppedEvents: Number(parsed.droppedEvents) || 0,
		};
	}

	private write(data: StoreFile): void {
		writeJsonAtomic(this.filePath, data);
	}
}
