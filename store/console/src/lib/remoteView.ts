/**
 * Zoom, pan and tap mapping for the live remote browser (#1105). Pure, so the subtle part — a tap at
 * any zoom and pan lands on the right point of the REAL page — is tested directly.
 *
 * Coordinates: the frame is drawn into a "stage" box (`box`, the frame fitted into the screen at
 * scale 1). Zooming transforms the frame inside that box with `translate(x, y) scale(scale)` from the
 * top-left corner, so a stage point `p` shows frame-image point `(p - x) / scale`. The page's CSS
 * viewport (`frame.width × frame.height`) maps linearly onto the image.
 */
export interface View {
	scale: number;
	x: number;
	y: number;
}
export interface Box {
	w: number;
	h: number;
}
export interface Point {
	x: number;
	y: number;
}

export const MIN_SCALE = 1;
export const MAX_SCALE = 5;
/** Double-tap zoom: in to this scale, centred on the tap; out to 1 from any zoom. */
export const DOUBLE_TAP_SCALE = 2.5;
export const IDENTITY: View = { scale: 1, x: 0, y: 0 };

/** The stage: the frame fitted (letterboxed) into the available area at scale 1. */
export function fitBox(area: Box, frame: { width: number; height: number }): Box {
	if (!area.w || !area.h || !frame.width || !frame.height) return { w: 0, h: 0 };
	const k = Math.min(area.w / frame.width, area.h / frame.height);
	return { w: frame.width * k, h: frame.height * k };
}

/** Keep the zoomed frame covering the stage: no zooming out past fit, no panning into empty space. */
export function clampView(v: View, box: Box): View {
	const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale));
	const clamp = (n: number, size: number) => Math.min(0, Math.max(size - size * scale, n));
	return { scale, x: clamp(v.x, box.w), y: clamp(v.y, box.h) };
}

/** Zoom to `scale`, keeping the frame point under `at` (a stage point) where it is — a pinch's centre. */
export function zoomAt(v: View, scale: number, at: Point, box: Box): View {
	const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
	const u = { x: (at.x - v.x) / v.scale, y: (at.y - v.y) / v.scale };
	return clampView({ scale: next, x: at.x - u.x * next, y: at.y - u.y * next }, box);
}

export function panBy(v: View, dx: number, dy: number, box: Box): View {
	return clampView({ scale: v.scale, x: v.x + dx, y: v.y + dy }, box);
}

/** Double-tap: zoom in on the tapped point, or back out to fit when already zoomed. */
export function doubleTap(v: View, at: Point, box: Box): View {
	return v.scale > MIN_SCALE ? IDENTITY : zoomAt(v, DOUBLE_TAP_SCALE, at, box);
}

/**
 * A stage point → the page's CSS-viewport pixel under it, at the current zoom and pan — the
 * coordinate CDP input expects. Null outside the frame (a tap on the letterbox does nothing).
 */
export function toPage(v: View, at: Point, box: Box, frame: { width: number; height: number }): Point | null {
	if (!box.w || !box.h) return null;
	const u = { x: (at.x - v.x) / v.scale, y: (at.y - v.y) / v.scale };
	if (u.x < 0 || u.y < 0 || u.x > box.w || u.y > box.h) return null;
	return {
		x: Math.min(frame.width - 1, Math.max(0, Math.round((u.x / box.w) * frame.width))),
		y: Math.min(frame.height - 1, Math.max(0, Math.round((u.y / box.h) * frame.height))),
	};
}

/** What the CSS transform must be for `v`. */
export const transformOf = (v: View) => `translate(${v.x}px, ${v.y}px) scale(${v.scale})`;
