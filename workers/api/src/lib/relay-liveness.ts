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
 * `probe()` — asked at CONNECT time — SENDS a ping and waits for the pong. Being wrong here is
 * cheap in one direction only: a false "alive" locks a machine out of its own slot (the bug),
 * while a false "dead" merely hands the slot to a newcomer that wanted it anyway. A relay DO is
 * keyed per (instance, node), so the "incumbent" is another process claiming the SAME hostname —
 * in practice the same machine. #237's promise still holds: a genuinely live runner answers a
 * ping in milliseconds and still gets its 4409.
 *
 * `observe()` — asked at STATUS time — never waits. It pings and judges on the PREVIOUS round
 * trip, because `relayConnected` is called in a per-node LOOP on every tool-call resolution path
 * (`runner-client.ts:86-96,141,167,175`) and on the chat context builder; a 1.5s wait per offline
 * node would add seconds to every agent turn. So the first status call after a peer freezes still
 * answers optimistically, and the next one (a poll or two later) tells the truth — which is the
 * whole distance from "reports connected forever" to "self-corrects in seconds", at zero latency.
 *
 * Both are optimistic when they know nothing: no ping has been sent yet, or the DO was
 * hibernated and lost its counters, reads as connected. An unknown must not be reported as an
 * outage — that is the same rule #348 states about unmetered spend, applied to liveness.
 */

/** The half of a WebSocket this module uses. Structural, so a test needs no Cloudflare runtime. */
export interface PingableSocket {
	send(data: string): void;
	close(code: number, reason: string): void;
}

/** How long an incumbent has to answer before a connecting runner may evict it. */
export const PONG_DEADLINE_MS = 1500;

/** How long an unanswered ping must stand before `observe` calls the peer gone. */
export const PONG_STALE_MS = 2000;

export class RunnerLiveness {
	private waiters = new Set<(alive: boolean) => void>();
	private lastPingAt = 0;
	private lastPongAt = 0;

	/** Record an inbound `"pong"`, and release anything waiting on one. */
	pong(now: number = Date.now()): void {
		this.lastPongAt = now;
		const waiting = [...this.waiters];
		this.waiters.clear();
		for (const w of waiting) w(true);
	}

	/**
	 * Ping every socket and return the ones that took it.
	 *
	 * A send that THROWS is the one unambiguous death: the socket is half-closed and can never
	 * carry anything again, so it is closed here rather than left in the DO's list to be
	 * re-pinged forever. An unanswered ping is NOT treated this way — the runner does synchronous
	 * local execs (tmux capture), so a live one can be briefly slow, and closing it would drop the
	 * commands in flight for a peer that was about to answer.
	 */
	private ping(sockets: readonly PingableSocket[], now: number): PingableSocket[] {
		const reachable: PingableSocket[] = [];
		for (const ws of sockets) {
			try {
				ws.send("ping");
				reachable.push(ws);
			} catch {
				try { ws.close(1000, "stale"); } catch { /* already closed */ }
			}
		}
		if (reachable.length > 0) this.lastPingAt = now;
		return reachable;
	}

	/**
	 * CONNECT-time question: is the incumbent answering right now?
	 *
	 * `false` means the caller may evict it. Unreachable sockets are `false` immediately — there
	 * is nothing to wait for.
	 */
	async probe(
		sockets: readonly PingableSocket[],
		opts: { deadlineMs?: number; now?: number } = {},
	): Promise<boolean> {
		const now = opts.now ?? Date.now();
		const deadlineMs = opts.deadlineMs ?? PONG_DEADLINE_MS;
		if (this.ping(sockets, now).length === 0) return false;
		return await new Promise<boolean>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const settle = (alive: boolean) => {
				if (timer) clearTimeout(timer);
				this.waiters.delete(settle);
				resolve(alive);
			};
			timer = setTimeout(() => settle(false), deadlineMs);
			this.waiters.add(settle);
		});
	}

	/**
	 * STATUS-time question, answered without waiting: does the evidence say this peer is gone?
	 *
	 * Sends a fresh ping (so the NEXT call has an answer to judge) and reports on the last one.
	 */
	observe(sockets: readonly PingableSocket[], now: number = Date.now()): boolean {
		const pingedAt = this.lastPingAt;
		const reachable = this.ping(sockets, now);
		if (reachable.length === 0) return false;
		// A ping that has been standing unanswered longer than the grace window is the evidence.
		// Anything younger than that is simply "we have not heard back yet", which is not an
		// outage — the whole point of pinging now is that the next caller gets a real answer.
		if (pingedAt > 0 && this.lastPongAt < pingedAt && now - pingedAt > PONG_STALE_MS) return false;
		return true;
	}
}
