/**
 * Unit-test the RelayDO's command dispatch, timeout, and replacement logic.
 *
 * `cloudflare:workers` isn't available in vitest, so we re-implement the
 * core protocol in a minimal harness that mirrors the real DO's behaviour.
 * This tests the *contract* (message format, timeout, replacement, status)
 * rather than the Cloudflare-specific WebSocket plumbing.
 */
import { describe, expect, it, vi, afterEach } from "vitest";

// ── Minimal relay protocol re-implementation for testing ────────────────
// Mirrors relay-do.ts logic without importing cloudflare:workers.

interface PendingRequest {
	resolve: (v: CommandResponse) => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface CommandResponse {
	id: string;
	status: number;
	result?: unknown;
	error?: string;
}

class MockWebSocket {
	sent: string[] = [];
	closed = false;
	send(data: string) {
		if (this.closed) throw new Error("closed");
		this.sent.push(data);
	}
	close() { this.closed = true; }
}

/** Stripped-down relay that exercises the same pending-map / timeout logic. */
class TestRelay {
	private pending = new Map<string, PendingRequest>();
	runner: MockWebSocket | null = null;

	connect(): MockWebSocket {
		// Replacement: reject pending, close old
		if (this.runner) {
			this.rejectAll("Runner replaced by new connection");
			this.runner.close();
		}
		this.runner = new MockWebSocket();
		return this.runner;
	}

	status(): { connected: boolean } {
		return { connected: this.runner !== null && !this.runner.closed };
	}

	async command(path: string, body?: unknown, method = "POST", timeoutMs = 120_000): Promise<CommandResponse> {
		if (!this.runner || this.runner.closed) throw new Error("No runner connected");

		const id = crypto.randomUUID();
		const cmd = { id, method, path, body };

		return new Promise<CommandResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("Relay command timed out"));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.runner!.send(JSON.stringify(cmd));
			} catch (err) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(err);
			}
		});
	}

	/** Simulates webSocketMessage from runner. */
	onMessage(data: string): void {
		let parsed: CommandResponse;
		try { parsed = JSON.parse(data); } catch { return; }
		if (!parsed.id) return;
		const pending = this.pending.get(parsed.id);
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pending.delete(parsed.id);
		pending.resolve(parsed);
	}

	/** Simulates webSocketClose. */
	onClose(): void {
		this.runner = null;
		this.rejectAll("Runner disconnected");
	}

	private rejectAll(reason: string): void {
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(new Error(reason));
		}
		this.pending.clear();
	}
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("RelayDO protocol", () => {
	afterEach(() => { vi.useRealTimers(); });

	it("status returns connected:false when no runner", () => {
		const relay = new TestRelay();
		expect(relay.status().connected).toBe(false);
	});

	it("status returns connected:true after a runner connects", () => {
		const relay = new TestRelay();
		relay.connect();
		expect(relay.status().connected).toBe(true);
	});

	it("command throws when no runner is connected", async () => {
		const relay = new TestRelay();
		await expect(relay.command("/health")).rejects.toThrow("No runner connected");
	});

	it("sends command to runner and resolves on response", async () => {
		const relay = new TestRelay();
		const ws = relay.connect();

		const p = relay.command("/browser/snapshot", { taskId: "t1" });

		// Runner receives command
		expect(ws.sent.length).toBe(1);
		const cmd = JSON.parse(ws.sent[0]) as { id: string; method: string; path: string; body: unknown };
		expect(cmd.path).toBe("/browser/snapshot");
		expect(cmd.method).toBe("POST");
		expect(cmd.body).toEqual({ taskId: "t1" });

		// Runner responds
		relay.onMessage(JSON.stringify({ id: cmd.id, status: 200, result: { snapshot: "<html>" } }));

		const result = await p;
		expect(result.status).toBe(200);
		expect(result.result).toEqual({ snapshot: "<html>" });
	});

	it("returns runner error faithfully", async () => {
		const relay = new TestRelay();
		const ws = relay.connect();

		const p = relay.command("/browser/act", {});
		const cmd = JSON.parse(ws.sent[0]) as { id: string };

		relay.onMessage(JSON.stringify({ id: cmd.id, status: 500, error: "Playwright timeout" }));

		const result = await p;
		expect(result.status).toBe(500);
		expect(result.error).toBe("Playwright timeout");
	});

	it("times out when runner never responds", async () => {
		vi.useFakeTimers();
		const relay = new TestRelay();
		relay.connect();

		const p = relay.command("/slow", {}, "POST", 5000);
		vi.advanceTimersByTime(6000);

		await expect(p).rejects.toThrow("timed out");
	});

	it("new connection replaces old one and rejects pending commands", async () => {
		const relay = new TestRelay();
		const oldWs = relay.connect();

		const p = relay.command("/test", {});
		expect(oldWs.sent.length).toBe(1);

		// New runner connects — old pending should be rejected
		const newWs = relay.connect();
		expect(oldWs.closed).toBe(true);

		await expect(p).rejects.toThrow("replaced");

		// New socket should work
		const p2 = relay.command("/test2", {});
		expect(newWs.sent.length).toBe(1);
		const cmd = JSON.parse(newWs.sent[0]) as { id: string };
		relay.onMessage(JSON.stringify({ id: cmd.id, status: 200, result: {} }));
		const result = await p2;
		expect(result.status).toBe(200);
	});

	it("runner disconnect rejects all pending commands", async () => {
		const relay = new TestRelay();
		relay.connect();

		const p1 = relay.command("/a", {});
		const p2 = relay.command("/b", {});

		relay.onClose();

		await expect(p1).rejects.toThrow("disconnected");
		await expect(p2).rejects.toThrow("disconnected");
		expect(relay.status().connected).toBe(false);
	});

	it("relays HTTP method from caller", async () => {
		const relay = new TestRelay();
		const ws = relay.connect();

		const p = relay.command("/health", undefined, "GET");
		const cmd = JSON.parse(ws.sent[0]) as { id: string; method: string };
		expect(cmd.method).toBe("GET");

		relay.onMessage(JSON.stringify({ id: cmd.id, status: 200, result: { ok: true } }));
		const result = await p;
		expect(result.result).toEqual({ ok: true });
	});

	it("ignores malformed messages from runner", () => {
		const relay = new TestRelay();
		relay.connect();
		// Should not throw
		relay.onMessage("not json");
		relay.onMessage(JSON.stringify({ no_id: true }));
		relay.onMessage(JSON.stringify({ id: "nonexistent", status: 200 }));
	});
});
