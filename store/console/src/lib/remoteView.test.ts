/**
 * #1105: a tap on the live remote browser lands on the right point of the REAL page at any zoom and
 * pan. The page in the report was SEEK's sign-in on dell-laptop: a 1280×720 CSS viewport shown on a
 * phone, where the stage is 390×219 — too small to tap at scale 1, which is why zoom is the headline.
 */
import { describe, expect, it } from "vitest";
import { clampView, doubleTap, fitBox, IDENTITY, MAX_SCALE, panBy, toPage, transformOf, zoomAt } from "./remoteView";

const FRAME = { width: 1280, height: 720 };
const PHONE = { w: 390, h: 640 };
const box = fitBox(PHONE, FRAME);

describe("the stage", () => {
	it("fits the page into the screen, letterboxed, at scale 1", () => {
		expect(box.w).toBeCloseTo(390);
		expect(box.h).toBeCloseTo(219.375);
		expect(fitBox({ w: 0, h: 0 }, FRAME)).toEqual({ w: 0, h: 0 });
	});
});

describe("mapping a tap to the page (#1105 — the subtle one)", () => {
	it("at scale 1, the stage maps linearly onto the page", () => {
		expect(toPage(IDENTITY, { x: 0, y: 0 }, box, FRAME)).toEqual({ x: 0, y: 0 });
		expect(toPage(IDENTITY, { x: box.w / 2, y: box.h / 2 }, box, FRAME)).toEqual({ x: 640, y: 360 });
	});

	it("after a pinch, the point under the fingers stays the same page point, and taps map through the zoom", () => {
		const centre = { x: 300, y: 150 };
		const before = toPage(IDENTITY, centre, box, FRAME);
		const zoomed = zoomAt(IDENTITY, 3, centre, box);
		// The pinch centre still shows the same page pixel.
		expect(toPage(zoomed, centre, box, FRAME)).toEqual(before);
		// A tap elsewhere maps through scale 3: 30 stage px right of centre is 10 image px, ~33 page px.
		const right = toPage(zoomed, { x: centre.x + 30, y: centre.y }, box, FRAME) as { x: number; y: number };
		expect(Math.abs(right.x - (before as { x: number }).x - (10 / box.w) * FRAME.width)).toBeLessThanOrEqual(1);
		expect(right.y).toBe((before as { y: number }).y);
	});

	it("panning moves which page point a tap reaches, by the pan divided by the zoom", () => {
		const zoomed = zoomAt(IDENTITY, 2, { x: 0, y: 0 }, box);
		const panned = panBy(zoomed, -100, -40, box);
		const tap = { x: 50, y: 50 };
		// Stage (50,50) shows image ((50 - x)/2, (50 - y)/2).
		const u = { x: (50 - panned.x) / 2, y: (50 - panned.y) / 2 };
		expect(toPage(panned, tap, box, FRAME)).toEqual({ x: Math.round((u.x / box.w) * 1280), y: Math.round((u.y / box.h) * 720) });
	});

	it("a sign-in field at the page's far corner is reachable when zoomed into that corner", () => {
		const corner = { x: box.w - 1, y: box.h - 1 };
		const zoomed = zoomAt(IDENTITY, MAX_SCALE, corner, box);
		const p = toPage(zoomed, corner, box, FRAME) as { x: number; y: number };
		expect(p.x).toBeGreaterThan(1270);
		expect(p.y).toBeGreaterThan(710);
	});

	it("a tap on the letterbox, outside the page, reaches nothing", () => {
		expect(toPage(IDENTITY, { x: 10, y: box.h + 20 }, box, FRAME)).toBeNull();
	});
});

describe("zoom and pan stay on the page", () => {
	it("never zooms out past fit or in past the maximum", () => {
		expect(zoomAt(IDENTITY, 0.2, { x: 10, y: 10 }, box).scale).toBe(1);
		expect(zoomAt(IDENTITY, 50, { x: 10, y: 10 }, box).scale).toBe(MAX_SCALE);
	});

	it("never pans into empty space", () => {
		const zoomed = zoomAt(IDENTITY, 2, { x: 0, y: 0 }, box);
		expect(panBy(zoomed, 500, 500, box)).toMatchObject({ x: 0, y: 0 });
		const far = panBy(zoomed, -5000, -5000, box);
		expect(far.x).toBeCloseTo(box.w - box.w * 2);
		expect(far.y).toBeCloseTo(box.h - box.h * 2);
		expect(clampView({ scale: 1, x: -30, y: 12 }, box)).toEqual({ scale: 1, x: 0, y: 0 });
	});

	it("double-tap zooms in on the tapped point, and back out to fit from any zoom", () => {
		const at = { x: 120, y: 80 };
		const zoomed = doubleTap(IDENTITY, at, box);
		expect(zoomed.scale).toBe(2.5);
		expect(toPage(zoomed, at, box, FRAME)).toEqual(toPage(IDENTITY, at, box, FRAME));
		expect(doubleTap(zoomed, at, box)).toEqual(IDENTITY);
	});

	it("renders as the transform the stage applies", () => {
		expect(transformOf({ scale: 2, x: -10, y: -5 })).toBe("translate(-10px, -5px) scale(2)");
	});
});
