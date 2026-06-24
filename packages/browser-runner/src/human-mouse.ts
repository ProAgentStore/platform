import type { CDPSession, Page } from "playwright";

/**
 * Humanized input layer: turn an "intent" (move to / click a control) into
 * human-like motion — a curved Bézier path with eased speed, sub-pixel jitter,
 * and natural press/release timing — instead of a teleport-and-click. This
 * raises behavioral reputation with anti-bot scoring (mouse-trajectory entropy)
 * so fewer challenges trigger. It is one layer of the anti-detection stack
 * (alongside real-profile + stealth), not a captcha bypass.
 */

export interface Point {
	x: number;
	y: number;
}
export interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

const rand = (min: number, max: number): number => min + Math.random() * (max - min);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
// easeInOutQuad — slow start, fast middle, slow approach (how a hand decelerates onto a target).
const ease = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

function cubicBezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
	const u = 1 - t;
	return {
		x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
		y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
	};
}

/** Move the cursor from `from` to `to` along a randomized human-like arc. */
export async function humanMoveTo(cdp: CDPSession, from: Point, to: Point): Promise<void> {
	const dist = Math.hypot(to.x - from.x, to.y - from.y);
	const steps = Math.max(12, Math.min(42, Math.round(dist / 9)));
	// Control points pushed off the straight line so the path bows like a real
	// hand's arc — bigger arc for longer travel.
	const off = Math.min(90, dist * 0.3);
	const c1: Point = {
		x: from.x + (to.x - from.x) * 0.33 + rand(-off, off),
		y: from.y + (to.y - from.y) * 0.33 + rand(-off, off),
	};
	const c2: Point = {
		x: from.x + (to.x - from.x) * 0.66 + rand(-off, off),
		y: from.y + (to.y - from.y) * 0.66 + rand(-off, off),
	};
	for (let i = 1; i <= steps; i++) {
		const p = cubicBezier(from, c1, c2, to, ease(i / steps));
		await cdp.send("Input.dispatchMouseEvent", {
			type: "mouseMoved",
			x: p.x + rand(-0.6, 0.6),
			y: p.y + rand(-0.6, 0.6),
		});
		await sleep(rand(5, 15));
	}
}

/** Click `to` with a human approach + natural press/release dwell. */
export async function humanClickAt(cdp: CDPSession, from: Point, to: Point): Promise<void> {
	await humanMoveTo(cdp, from, to);
	await sleep(rand(40, 130));
	await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: to.x, y: to.y, button: "left", buttons: 1, clickCount: 1 });
	await sleep(rand(40, 100));
	await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
}

/** Pick a natural target point inside a box (not dead-center) + an off-screen-ish start. */
export function targetIn(box: Box): { from: Point; to: Point } {
	const to: Point = {
		x: box.x + box.width / 2 + rand(-box.width * 0.2, box.width * 0.2),
		y: box.y + box.height / 2 + rand(-box.height * 0.25, box.height * 0.25),
	};
	const from: Point = { x: to.x + rand(-260, -40), y: to.y - rand(60, 260) };
	return { from, to };
}

/**
 * Best-effort humanized approach to an element before the caller's real click,
 * so the cursor arrives the way a hand would. Never throws — humanization must
 * not break the underlying action.
 */
export async function humanApproach(page: Page, box: Box | null): Promise<void> {
	if (!box) return;
	try {
		const cdp = await page.context().newCDPSession(page);
		const { from, to } = targetIn(box);
		await humanMoveTo(cdp, from, to);
		await cdp.detach().catch(() => undefined);
	} catch {
		// humanization is an enhancement, never a hard dependency
	}
}
