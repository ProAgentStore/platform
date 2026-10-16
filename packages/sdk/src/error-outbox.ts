/**
 * The browser error outbox (#1088) — how a client failure reaches the durable log, reliably.
 *
 * The reporter it replaces sent each failure once, fire-and-forget: it deduped BEFORE sending, ignored the
 * HTTP answer and swallowed a rejected fetch. So a report sent while offline, or refused with a 503, was
 * gone — and the 30-second dedupe then suppressed the next real report of the same failure too.
 *
 * Now every report is an EVENT with a stable id, kept in a bounded outbox until the platform acknowledges
 * it:
 *
 *  - **Delivered = acknowledged.** 200 (stored) and 202 (spooled server-side, #1084) remove it. 429, 5xx
 *    and a network failure keep it and retry with backoff; a 400/413/422 can never succeed, so it is dropped
 *    and counted. The id makes a retry idempotent server-side, so "sent but the answer was lost" is safe.
 *  - **Occurrences are counted, not discarded.** A repeat of a failure still waiting folds into its event's
 *    `count`. A repeat within 30 s of a DELIVERED report waits out the 30 s and is sent as one event with
 *    its count — the rate limit holds, nothing is silently dropped, and the throttle starts only on success.
 *  - **Offline and reload.** The outbox lives in `localStorage` (≤ 50 events), so a report made offline or
 *    just before a reload is sent on the next load or `online` event. Overflow keeps the oldest events and
 *    counts the rest (`droppedReports` rides on the next delivered event).
 *  - **Attribution is never upgraded.** An event made with no session stays anonymous when replayed after
 *    sign-in; one made under a session is sent only under that same session (a fingerprint, not the token,
 *    is stored), otherwise anonymously.
 *
 * Limits: a browser that closes while offline delivers on its next visit to the same origin, or never; a
 * cleared site storage loses what was waiting. Both are the browser's to decide, and are stated here.
 */

export interface OutboxEvent {
	id: string;
	source: string;
	message: string;
	status?: number;
	context?: Record<string, unknown>;
	build: string;
	/** Occurrences this event stands for. */
	count: number;
	/** "anon", or a fingerprint of the session it was made under. */
	auth: string;
	createdAt: number;
	/** Not before this time — backoff after a failed attempt, or the per-failure throttle. */
	nextAt: number;
	attempts: number;
}

export interface OutboxRequest {
	method: "POST";
	keepalive: boolean;
	headers: Record<string, string>;
	body: string;
}

export interface OutboxDeps {
	endpoint: string;
	/** The request is described here rather than as DOM `RequestInit`, so a Worker test can drive the outbox too. */
	fetch: (url: string, init: OutboxRequest) => Promise<{ ok: boolean; status: number }>;
	storage: { getItem(k: string): string | null; setItem(k: string, v: string): void } | null;
	now: () => number;
	online: () => boolean;
	token: () => string | null;
	schedule: (fn: () => void, ms: number) => void;
	newId: () => string;
}

export const OUTBOX_KEY = "pags:error-outbox";
export const MAX_EVENTS = 50;
export const THROTTLE_MS = 30_000;
/** Backoff per failed attempt; past the last step the event is given up on (and counted). */
export const BACKOFF_MS = [2_000, 10_000, 30_000, 120_000, 300_000, 900_000, 1_800_000, 3_600_000];
/** Answers that can never succeed on a retry. */
const PERMANENT = new Set([400, 413, 422]);

/** A short, non-reversible fingerprint of a session — enough to tell "the same session" apart. */
export function sessionFingerprint(token: string | null): string {
	if (!token) return "anon";
	let h = 2166136261;
	for (let i = 0; i < token.length; i++) h = Math.imul(h ^ token.charCodeAt(i), 16777619);
	return `s${(h >>> 0).toString(36)}`;
}

export class ErrorOutbox {
	private events: OutboxEvent[] = [];
	private dropped = 0;
	private lastDelivered = new Map<string, number>();
	private flushing = false;
	private running: Promise<void> | null = null;
	private sending: OutboxEvent | null = null;
	private timerAt = 0;

	constructor(private readonly deps: OutboxDeps) {
		this.load();
	}

	/** Record one occurrence of a failure, and try to send what is due. */
	report(e: { source: string; message: string; status?: number; context?: Record<string, unknown>; build: string }): void {
		const now = this.deps.now();
		const auth = sessionFingerprint(this.deps.token());
		const key = `${e.source}|${e.message}`;
		// A repeat folds into the event still waiting for the same failure — anything but the one on the wire.
		const waiting = this.events.find((x) => x !== this.sending && `${x.source}|${x.message}` === key && x.auth === auth);
		if (waiting) {
			waiting.count++;
		} else {
			if (this.events.length >= MAX_EVENTS) {
				this.dropped++;
				this.save();
				return;
			}
			const sent = this.lastDelivered.get(key);
			const onTheWire = this.sending && `${this.sending.source}|${this.sending.message}` === key;
			const throttledUntil = Math.max(sent ? sent + THROTTLE_MS : 0, onTheWire ? now + THROTTLE_MS : 0);
			this.events.push({ id: this.deps.newId(), source: e.source, message: e.message, ...(typeof e.status === "number" ? { status: e.status } : {}), ...(e.context ? { context: e.context } : {}), build: e.build, count: 1, auth, createdAt: now, nextAt: Math.max(now, throttledUntil), attempts: 0 });
		}
		this.save();
		void this.flush();
	}

	/**
	 * Send every event that is due, one at a time. Safe to call at any time; never throws. A call while a
	 * flush is running joins it — the promise settles when the delivery in progress has.
	 */
	flush(): Promise<void> {
		if (this.flushing && this.running) return this.running;
		this.flushing = true;
		this.running = this.drain();
		return this.running;
	}

	private async drain(): Promise<void> {
		try {
			while (this.deps.online()) {
				const now = this.deps.now();
				const due = this.events.find((x) => x.nextAt <= now);
				if (!due) break;
				await this.send(due);
			}
		} finally {
			// Cleared synchronously at the end of the drain: a drain that sent nothing (offline) must not
			// leave a settled promise posing as the one in progress.
			this.flushing = false;
			this.arm();
		}
	}

	/** What is waiting — for tests and diagnostics. */
	pending(): readonly OutboxEvent[] {
		return this.events;
	}

	droppedCount(): number {
		return this.dropped;
	}

	private async send(ev: OutboxEvent): Promise<void> {
		const token = this.deps.token();
		const authorized = ev.auth !== "anon" && sessionFingerprint(token) === ev.auth;
		const context = this.dropped ? { ...(ev.context ?? {}), droppedReports: this.dropped } : ev.context;
		const reportedDrops = this.dropped;
		let status = 0;
		this.sending = ev;
		try {
			const res = await this.deps.fetch(this.deps.endpoint, {
				method: "POST",
				keepalive: true,
				headers: { "Content-Type": "application/json", ...(authorized ? { Authorization: `Bearer ${token}` } : {}) },
				body: JSON.stringify({ id: ev.id, source: ev.source, message: ev.message, status: ev.status, context, build: ev.build, count: ev.count }),
			});
			status = res.status;
			if (res.ok) {
				this.remove(ev);
				this.dropped = Math.max(0, this.dropped - reportedDrops);
				this.lastDelivered.set(`${ev.source}|${ev.message}`, this.deps.now());
				if (this.lastDelivered.size > 200) this.lastDelivered.clear();
				this.save();
				return;
			}
		} catch {
			// Network failure: retried below, exactly like a 5xx.
		} finally {
			this.sending = null;
		}
		if (PERMANENT.has(status)) {
			this.remove(ev);
			this.dropped++;
			this.save();
			return;
		}
		ev.attempts++;
		if (ev.attempts > BACKOFF_MS.length) {
			this.remove(ev);
			this.dropped++;
		} else {
			ev.nextAt = this.deps.now() + BACKOFF_MS[ev.attempts - 1];
		}
		this.save();
	}

	private remove(ev: OutboxEvent): void {
		this.events = this.events.filter((x) => x !== ev);
	}

	/** Wake up for the next due event. One timer at a time. */
	private arm(): void {
		// Offline: no timer — a timer would only spin. The `online` event flushes (client.ts).
		if (!this.events.length || !this.deps.online()) return;
		const next = Math.min(...this.events.map((x) => x.nextAt));
		if (this.timerAt && this.timerAt <= next) return;
		this.timerAt = next;
		this.deps.schedule(() => {
			this.timerAt = 0;
			void this.flush();
		}, Math.max(0, next - this.deps.now()));
	}

	private load(): void {
		try {
			const raw = this.deps.storage?.getItem(OUTBOX_KEY);
			if (!raw) return;
			const parsed = JSON.parse(raw) as { events?: unknown; dropped?: unknown };
			const events = Array.isArray(parsed.events) ? (parsed.events as OutboxEvent[]).filter((x) => x && typeof x.id === "string" && typeof x.message === "string") : [];
			this.events = events.slice(0, MAX_EVENTS);
			this.dropped = typeof parsed.dropped === "number" ? parsed.dropped : 0;
		} catch {
			// Unreadable outbox: start empty. Site storage is the browser's; there is no evidence to keep.
			this.events = [];
		}
	}

	private save(): void {
		try {
			this.deps.storage?.setItem(OUTBOX_KEY, JSON.stringify({ v: 1, events: this.events, dropped: this.dropped }));
		} catch {
			// Storage full or blocked: the outbox still works in memory for this page.
		}
	}
}
