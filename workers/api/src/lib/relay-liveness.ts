/**
 * Is the runner holding this relay slot actually there? (#497)
 *
 * ── What was wrong ──
 *
 * `RelayDO.handleConnect` decided an incumbent socket was alive by whether `ws.send("ping")`
 * threw. Nothing ever required the pong to come back: `webSocketMessage` dropped `"pong"` on the
 * floor and no timer, alarm or last-seen was kept. A peer that has stopped existing at the
 * application layer — a slept laptop — therefore still counted as alive and kept its slot.
 *
 * Measured in production against `api.proagentstore.online` (issue #497, throwaway node name):
 * a SIGKILLed holder does NOT conflict (its socket is gone from the DO's list), but a SIGSTOPped
 * holder — the shape of a frozen laptop — held the slot and forced `4409` on every reconnect for
 * ~5 minutes, until Cloudflare evicted the abandoned hibernatable socket. The CLI treats a 4409 as
 * terminal for the life of the process, so a five-minute server window cost the whole run: the
 * owner's Air was left holding 6 of 19 sockets with a `pags up` that would never try again.
 *
 * ── Two questions, two answers, deliberately different ──
 *
 * `probe()` — asked at CONNECT time and before a command is dispatched — SENDS a ping and waits
 * for the pong. Being wrong here is cheap in one direction only: a false "alive" locks a machine
 * out of its own slot (the bug), or makes a command wait its much longer execution timeout; a
 * false "dead" merely hands the slot to a newcomer that wanted it anyway or asks a caller to
 * retry. A relay DO is keyed per (instance, node), so the "incumbent" is another process claiming
 * the SAME hostname — in practice the same machine. #237's promise still holds: a genuinely live
 * runner answers a ping in milliseconds and still gets its 4409.
 *
 * `observe()` — asked at STATUS time — never waits. It pings and judges on the PREVIOUS round
 * trip, because `relayConnected` is called in a per-node LOOP on every tool-call resolution path
 * (`runner-client.ts:86-96,141,167,175`) and on the chat context builder; a 1.5s wait per offline
 * node would add seconds to every agent turn. So the first status call after a peer freezes still
 * answers optimistically, and the next one (a poll or two later) tells the truth — which is the
 * whole distance from "reports connected forever" to "self-corrects in seconds", at zero latency.
 *
 * Both are optimistic when they know nothing: a socket that has never been pinged reads as
 * connected. An unknown must not be reported as an outage - that is the same rule #348 states about
 * unmetered spend, applied to liveness. Since #1183 a hibernation no longer makes everything
 * unknown: each socket's last ping and pong live in its hibernation attachment.
 */
import { RELAY_PONG_DEADLINE_MS } from "./runner-timeouts.js";


/** The half of a WebSocket this module uses. Structural, so a test needs no Cloudflare runtime. */
export interface PingableSocket {
	send(data: string): void;
	close(code: number, reason: string): void;
	/** Hibernation attachments (#1183): survive the DO being evicted, so a socket's last ping and pong do too. Absent in a bare test double. */
	serializeAttachment?(value: unknown): void;
	deserializeAttachment?(): unknown;
}

/** How long an incumbent has to answer before a connecting runner may evict it. */
export const PONG_DEADLINE_MS = RELAY_PONG_DEADLINE_MS;

/** How long an unanswered ping must stand before `observe` calls the peer gone. */
export const PONG_STALE_MS = 2000;

/** One socket's own evidence: when it was last pinged and last answered (ms epoch; 0 = never). */
interface SocketRecord {
	pingAt: number;
	pongAt: number;
}

/** The attachment key the record lives under, beside whatever else a socket carries. */
const ATTACHMENT_KEY = "liveness";

/**
 * Per-SOCKET ping/pong bookkeeping (#1183).
 *
 * It used to be two counters in the DO's memory, one pair for the whole slot. Two consequences: after hibernation the counters were
 * gone and the first `/status` read "connected" whatever the peer was doing; and in a slot with two sockets one live pong vouched
 * for a dead one. Now each socket has its own record, written into its hibernation attachment as it changes, so it survives the DO
 * being evicted and is read back from the socket itself. A socket with no record at all (accepted before this) is still unknown and
 * reads as connected ONCE - that is the same rule as before for a genuine unknown - but the ping that call sends starts its record.
 */
export class RunnerLiveness {
	private waiters = new Set<{ sockets: Set<PingableSocket>; settle: (alive: PingableSocket[]) => void }>();
	private memory = new WeakMap<PingableSocket, SocketRecord>();
	/** The last pong that named no socket. Only the slot-wide fallback uses it; the relay always names the socket. */
	private anonymousPongAt = 0;

	private read(ws: PingableSocket): SocketRecord | null {
		const mem = this.memory.get(ws);
		if (mem) return mem;
		try {
			const att = ws.deserializeAttachment?.() as Record<string, unknown> | null | undefined;
			const rec = att?.[ATTACHMENT_KEY] as Partial<SocketRecord> | undefined;
			if (rec && typeof rec.pingAt === "number" && typeof rec.pongAt === "number") {
				const restored = { pingAt: rec.pingAt, pongAt: rec.pongAt };
				this.memory.set(ws, restored);
				return restored;
			}
		} catch {
			/* no attachment, or one that cannot be read: unknown */
		}
		return null;
	}

	private write(ws: PingableSocket, rec: SocketRecord): void {
		this.memory.set(ws, rec);
		try {
			if (!ws.serializeAttachment) return;
			const att = (ws.deserializeAttachment?.() as Record<string, unknown> | null | undefined) ?? {};
			ws.serializeAttachment({ ...(typeof att === "object" ? att : {}), [ATTACHMENT_KEY]: rec });
		} catch {
			/* the in-memory record still stands for this wake */
		}
	}

	/**
	 * Record an inbound `"pong"` from `ws`, and release anything waiting on it.
	 *
	 * A pong credits THAT socket only. Called with no socket (a bare number or nothing) it credits every socket that has an unanswered
	 * ping - the old slot-wide behaviour, kept for callers that cannot say which socket answered.
	 */
	pong(from?: PingableSocket | number, at?: number): void {
		const ws = typeof from === "object" ? from : undefined;
		const now = typeof from === "number" ? from : (at ?? Date.now());
		const answered: PingableSocket[] = [];
		if (ws) {
			this.write(ws, { pingAt: this.read(ws)?.pingAt ?? 0, pongAt: now });
			answered.push(ws);
		} else {
			for (const w of this.waiters) for (const s of w.sockets) answered.push(s);
			for (const s of answered) this.write(s, { pingAt: this.read(s)?.pingAt ?? 0, pongAt: now });
			this.anonymousPongAt = now;
		}
		for (const w of [...this.waiters]) {
			const hit = answered.filter((s) => w.sockets.has(s));
			if (hit.length) w.settle(hit);
		}
	}

	/**
	 * Ping every socket and return the ones that took it.
	 *
	 * A send that THROWS is the one unambiguous death: the socket is half-closed and can never
	 * carry anything again, so it is closed here rather than left in the DO's list to be
	 * re-pinged forever. An unanswered ping is NOT treated this way - the runner does synchronous
	 * local execs (tmux capture), so a live one can be briefly slow, and closing it would drop the
	 * commands in flight for a peer that was about to answer.
	 */
	private ping(sockets: readonly PingableSocket[], now: number): PingableSocket[] {
		const reachable: PingableSocket[] = [];
		for (const ws of sockets) {
			try {
				ws.send("ping");
				reachable.push(ws);
				this.write(ws, { pingAt: now, pongAt: Math.max(this.read(ws)?.pongAt ?? 0, this.anonymousPongAt) });
			} catch {
				try { ws.close(1000, "stale"); } catch { /* already closed */ }
			}
		}
		return reachable;
	}

	/**
	 * The sockets that answer a ping right now (empty when none does within the deadline). Resolves as soon as one has answered, so a
	 * dead socket beside a live one costs a command nothing, and the caller can send on a socket that is known to be there.
	 */
	async probeAlive(
		sockets: readonly PingableSocket[],
		opts: { deadlineMs?: number; now?: number } = {},
	): Promise<PingableSocket[]> {
		const now = opts.now ?? Date.now();
		const deadlineMs = opts.deadlineMs ?? PONG_DEADLINE_MS;
		const reachable = this.ping(sockets, now);
		if (reachable.length === 0) return [];
		return await new Promise<PingableSocket[]>((resolve) => {
			const waiter = {
				sockets: new Set(reachable),
				settle: (alive: PingableSocket[]) => {
					clearTimeout(timer);
					this.waiters.delete(waiter);
					resolve(alive);
				},
			};
			const timer = setTimeout(() => waiter.settle([]), deadlineMs);
			this.waiters.add(waiter);
		});
	}

	/**
	 * Explicit liveness question: is the peer answering right now?
	 *
	 * `false` means a connect caller may evict it and a command caller must fail fast. Unreachable
	 * sockets are `false` immediately - there is nothing to wait for.
	 */
	async probe(sockets: readonly PingableSocket[], opts: { deadlineMs?: number; now?: number } = {}): Promise<boolean> {
		return (await this.probeAlive(sockets, opts)).length > 0;
	}

	/**
	 * STATUS-time question, answered without waiting: does the evidence say this slot's peer is gone?
	 *
	 * Sends a fresh ping to every socket (so the NEXT call has an answer to judge) and judges each socket on ITS OWN previous round
	 * trip: a socket is gone when its last ping has stood unanswered past the grace window. The slot is connected while any socket is
	 * not gone - a pong from one never clears another.
	 */
	observe(sockets: readonly PingableSocket[], now: number = Date.now()): boolean {
		// Each socket's verdict is taken BEFORE this call's ping overwrites its record.
		const before = new Map(sockets.map((ws) => [ws, this.read(ws)] as const));
		const reachable = this.ping(sockets, now);
		if (reachable.length === 0) return false;
		return reachable.some((ws) => {
			const rec = before.get(ws);
			// No record at all: unknown, and an unknown is not an outage. This call's ping starts it.
			if (!rec || rec.pingAt === 0) return true;
			// A ping standing unanswered longer than the grace window is the evidence, for THIS socket.
			return !(rec.pongAt < rec.pingAt && now - rec.pingAt > PONG_STALE_MS);
		});
	}
}

/** What {@link evictStaleSockets} found in one agent's slot on one machine. */
export interface StaleSocketVerdict {
	/** Sockets the slot held when asked. */
	sockets: number;
	/** One of them answered a ping — the agent IS attached there, and nothing was touched. */
	alive: boolean;
	/** Sockets closed because none answered — the slot is now free for a runner to take. */
	evicted: number;
}

/**
 * Free an agent's relay slot of a socket nobody is behind any more (#856).
 *
 * A frozen or duplicate runner's socket keeps the slot: the relay answers a new runner 4409
 * "another runner is already connected", the runner blocks the agent, and the only way out was
 * `pags up --force` typed at the machine. This is the half of that force the platform can do
 * remotely and SAFELY: it closes the slot's sockets only when not one of them answers a ping within
 * the deadline — never a live peer, which would be taking over an attached agent, not clearing a
 * stale one. Code 4410 rather than 4409, so a runner that is merely slow reconnects instead of
 * reading a conflict and giving up.
 */
export async function evictStaleSockets(
	sockets: readonly PingableSocket[],
	liveness: RunnerLiveness,
	opts: { deadlineMs?: number } = {},
): Promise<StaleSocketVerdict> {
	if (sockets.length === 0) return { sockets: 0, alive: false, evicted: 0 };
	if (await liveness.probe(sockets, { deadlineMs: opts.deadlineMs ?? PONG_DEADLINE_MS })) return { sockets: sockets.length, alive: true, evicted: 0 };
	for (const ws of sockets) {
		try {
			ws.close(4410, "stale runner socket evicted so the agent can reattach");
		} catch {
			/* already closed */
		}
	}
	return { sockets: sockets.length, alive: false, evicted: sockets.length };
}

/**
 * Send one command frame on the first socket that will take it; `null` if none will (#880).
 *
 * `RelayDO.handleCommand` used to send on `sockets[0]` unconditionally. The liveness probe that
 * runs just before it closes any socket whose ping `send` throws — so when the slot held a
 * half-closed socket first and a live one second, the probe passed (the live one answered) and the
 * command then went to the socket the probe had just closed, failing with the runtime's raw
 * "Can't call WebSocket send() after close()". Whether a call hit that or a clean timeout depended
 * on list order, which is why the same health check read differently seconds apart.
 *
 * A socket whose `send` throws is closed here too, for the same reason `ping` closes it.
 */
export function sendOnFirstOpen<T extends PingableSocket>(sockets: readonly T[], data: string): T | null {
	for (const ws of sockets) {
		try {
			ws.send(data);
			return ws;
		} catch {
			try { ws.close(1000, "stale"); } catch { /* already closed */ }
		}
	}
	return null;
}

/**
 * The runner's relay round-trip probe (#924): `rtt:<id>` is answered `rtt-echo:<id>` straight away,
 * so the runner can time the relay — "slow" vs "stuck" — and report it on its heartbeat. Returns the
 * reply, or null when the message is not a probe. The id is the runner's, bounded and echoed verbatim.
 */
export function rttEcho(text: string): string | null {
	const m = /^rtt:([\w-]{1,64})$/.exec(text);
	return m ? `rtt-echo:${m[1]}` : null;
}
