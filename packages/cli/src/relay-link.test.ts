/**
 * #1300 — the Secure link follows the relay's real lifecycle lines (the exact strings `relay.ts` writes), per agent.
 * Sequence tests: connect / disconnect / reconnect for one agent, partial and total loss for several.
 */
import { describe, expect, it } from "vitest";
import { RelayLinks } from "./relay-link.js";
import { describe as describeRow } from "./tui.js";

const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-2222-4222-8222-222222222222";
const C = "cccccccc-3333-4333-8333-333333333333";
// The lines as relay.ts writes them: `${id.slice(0, 8)}…`.
const up = (id: string) => `Relay connected: ${id.slice(0, 8)}…`;
const down = (id: string, reason = "server reboot") => `Relay disconnected: ${id.slice(0, 8)}… (${reason}) — reconnecting in 1s`;
const conflict = (id: string) => `Relay conflict: ${id.slice(0, 8)}… is connected on another machine — run \`pags up --force\` here to take it over.`;
const cleared = (id: string) => `Relay conflict cleared: ${id.slice(0, 8)}… — the other runner is gone; reattaching.`;

describe("one agent", () => {
	it("starting → connected → disconnected → reconnected", () => {
		const links = new RelayLinks([A]);
		expect(links.summary().tunnel).toBe("starting");
		expect(links.apply(up(A))).toMatchObject({ tunnel: "online", note: "" });
		const lost = links.apply(down(A));
		expect(lost).toMatchObject({ tunnel: "offline" }); // the reported failure: it stayed "online"
		expect(lost?.note).toMatch(/reconnecting/);
		expect(lost?.event).toMatch(/server reboot/);
		expect(links.apply(up(A))).toMatchObject({ tunnel: "online", note: "" });
	});

	it("a conflict is offline with the remedy, and clearing it is not yet connected", () => {
		const links = new RelayLinks([A]);
		links.apply(up(A));
		expect(links.apply(conflict(A))).toMatchObject({ tunnel: "offline" });
		expect(links.summary().note).toMatch(/pags up --force/);
		expect(links.apply(cleared(A))?.tunnel).toBe("offline");
		expect(links.apply(up(A))?.tunnel).toBe("online");
	});

	it("repeated disconnects stay offline (backoff retries)", () => {
		const links = new RelayLinks([A]);
		links.apply(up(A));
		for (let i = 0; i < 3; i++) expect(links.apply(down(A, "1006"))?.tunnel).toBe("offline");
	});
});

describe("several agents", () => {
	it("one connected is not all connected", () => {
		const links = new RelayLinks([A, B, C]);
		const s = links.apply(up(A));
		expect(s?.tunnel).toBe("starting");
		expect(s?.note).toBe("1 of 3 agents connected — 2 reconnecting");
		links.apply(up(B));
		expect(links.summary().tunnel).toBe("starting");
		expect(links.apply(up(C))?.tunnel).toBe("online");
	});

	it("one disconnect does not mark the healthy ones offline — it says how many are left", () => {
		const links = new RelayLinks([A, B, C]);
		for (const id of [A, B, C]) links.apply(up(id));
		const s = links.apply(down(B));
		expect(s?.tunnel).toBe("starting");
		expect(s?.note).toBe("2 of 3 agents connected — 1 reconnecting");
		expect(links.apply(up(B))?.tunnel).toBe("online");
	});

	it("losing every one is offline; recovery goes through partial back to online", () => {
		const links = new RelayLinks([A, B]);
		links.apply(up(A));
		links.apply(up(B));
		links.apply(down(A));
		expect(links.apply(down(B))?.tunnel).toBe("offline");
		expect(links.apply(up(A))?.note).toBe("1 of 2 agents connected — 1 reconnecting");
		expect(links.apply(up(B))?.tunnel).toBe("online");
	});

	it("a conflict on one agent is named in the partial note", () => {
		const links = new RelayLinks([A, B]);
		links.apply(up(A));
		expect(links.apply(conflict(B))?.note).toMatch(/1 of 2 agents connected.*1 held by another runner/);
	});

	it("an agent attached later (discovery) joins the count", () => {
		const links = new RelayLinks([A]);
		links.apply(up(A));
		expect(links.apply(up(B))?.tunnel).toBe("online");
		expect(links.apply(down(B))?.note).toBe("1 of 2 agents connected — 1 reconnecting");
	});
});

describe("what is not a lifecycle line", () => {
	it("returns null, leaving registration and heartbeat lines to their own parser", () => {
		const links = new RelayLinks([A]);
		for (const line of ["PAGS-STATUS registration=ok agents=1/1", "PAGS-STATUS heartbeat=fail reason=x", "✅ CONNECTED — WebSocket relay · host", "Runtime registered with PAGS ✓ (1 agents)"]) {
			expect(links.apply(line)).toBeNull();
		}
		expect(links.summary().tunnel).toBe("starting"); // the startup banner proves nothing
	});

	it("the Secure link row shows red when offline and amber while partly up", () => {
		expect(describeRow("tunnel", "offline").note).toBe("offline");
		expect(describeRow("tunnel", "starting").note).toBe("opening…");
	});
});
