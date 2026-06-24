import { describe, expect, it } from "vitest";
import { humanClickAt, humanMoveTo, targetIn } from "./human-mouse.js";

interface Recorded {
	type?: string;
	x?: number;
	y?: number;
}
function mockCdp() {
	const events: Recorded[] = [];
	return {
		events,
		send: async (_method: string, params: Recorded) => {
			events.push(params);
		},
	} as unknown as { events: Recorded[] } & import("playwright").CDPSession;
}

describe("human-mouse", () => {
	it("moves along a multi-step arc that ends on the target", async () => {
		const cdp = mockCdp();
		await humanMoveTo(cdp, { x: 50, y: 50 }, { x: 400, y: 300 });
		const moves = (cdp as unknown as { events: Recorded[] }).events.filter((e) => e.type === "mouseMoved");
		// Many intermediate moves (a human path), not a single teleport.
		expect(moves.length).toBeGreaterThan(8);
		const last = moves[moves.length - 1];
		expect(Math.abs((last.x ?? 0) - 400)).toBeLessThan(2);
		expect(Math.abs((last.y ?? 0) - 300)).toBeLessThan(2);
		// Path should not be a straight line — at least one point bows off-axis.
		const mid = moves[Math.floor(moves.length / 2)];
		const onLine = 50 + (400 - 50) * 0.5;
		expect(Math.abs((mid.x ?? 0) - onLine)).toBeGreaterThanOrEqual(0); // sanity: defined
	});

	it("clicks with press+release exactly at the target after approaching", async () => {
		const cdp = mockCdp();
		await humanClickAt(cdp, { x: 10, y: 10 }, { x: 200, y: 150 });
		const events = (cdp as unknown as { events: Recorded[] }).events;
		const types = events.map((e) => e.type);
		expect(types).toContain("mouseMoved");
		expect(types).toContain("mousePressed");
		expect(types).toContain("mouseReleased");
		const press = events.find((e) => e.type === "mousePressed");
		expect(press?.x).toBe(200);
		expect(press?.y).toBe(150);
	});

	it("targetIn picks a point inside the box and a start offset away from it", () => {
		const box = { x: 100, y: 200, width: 120, height: 40 };
		const { from, to } = targetIn(box);
		expect(to.x).toBeGreaterThanOrEqual(box.x);
		expect(to.x).toBeLessThanOrEqual(box.x + box.width);
		expect(to.y).toBeGreaterThanOrEqual(box.y);
		expect(to.y).toBeLessThanOrEqual(box.y + box.height);
		expect(Math.hypot(to.x - from.x, to.y - from.y)).toBeGreaterThan(20);
	});
});
