import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunnerEvent, RunnerSession, RunnerTask } from "./types.js";

interface StoreFile {
	sessions: RunnerSession[];
	tasks: RunnerTask[];
	events: RunnerEvent[];
}

function emptyStore(): StoreFile {
	return {
		sessions: [],
		tasks: [],
		events: [],
	};
}

export class RunnerStore {
	private readonly filePath: string;

	constructor(dataDir: string) {
		this.filePath = join(dataDir, "runner-store.json");
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
		data.events = data.events.slice(0, 500);
		this.write(data);
		return row;
	}

	listEvents(limit = 100): RunnerEvent[] {
		return this.read().events.slice(0, limit);
	}

	private read(): StoreFile {
		if (!existsSync(this.filePath)) return emptyStore();
		try {
			const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as Partial<StoreFile>;
			return {
				sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
				tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
				events: Array.isArray(parsed.events) ? parsed.events : [],
			};
		} catch {
			return emptyStore();
		}
	}

	private write(data: StoreFile): void {
		mkdirSync(dirname(this.filePath), { recursive: true });
		writeFileSync(this.filePath, `${JSON.stringify(data, null, 2)}\n`, {
			mode: 0o600,
		});
	}
}
