// useModalLock — what a modal overlay owes the page behind it (#1308).
//
// A `fixed inset-0` scrim does not stop the page under it scrolling. The console scrolls an
// inner `<main>` or tab div, not `body`, so "lock body" (what the first two overlays did) locks
// nothing; and the keyboard (End, PageDown, Space) scrolls whatever contains the focused element,
// which for an overlay opened from a button is still the page. So a modal must (1) freeze every
// scroll container it sits inside, (2) put focus inside itself and keep Tab there, and (3) give
// both back exactly as it found them.
//
// The freeze is reference-counted PER ELEMENT. Two overlays open at once share the page's scroll
// owner; the first one's cleanup must not unlock it under the second, and the last one's must
// restore the ORIGINAL inline `overflow`, not the "hidden" the first one left behind.

import { type RefObject, useEffect, useState } from "react";

interface Frozen {
	count: number;
	overflow: string;
	paddingRight: string;
	scrollTop: number;
}

const frozen = new Map<Element, Frozen>();

const SCROLLABLE = /(auto|scroll|overlay)/;

/** Every ancestor of `from` that scrolls vertically, plus the document's own scroller. */
function scrollOwners(from: Element): Element[] {
	const owners = new Set<Element>();
	for (let el = from.parentElement; el; el = el.parentElement) {
		if (SCROLLABLE.test(getComputedStyle(el).overflowY)) owners.add(el);
	}
	if (document.scrollingElement) owners.add(document.scrollingElement);
	owners.add(document.body);
	return [...owners];
}

/** Freeze the scroll containers around `from`. Returns the release; calling it twice is harmless. */
export function freezeScrollOwners(from: Element): () => void {
	const held = scrollOwners(from).filter((el): el is HTMLElement => el instanceof HTMLElement);
	for (const el of held) {
		const entry = frozen.get(el);
		if (entry) {
			entry.count++;
			continue;
		}
		frozen.set(el, { count: 1, overflow: el.style.overflow, paddingRight: el.style.paddingRight, scrollTop: el.scrollTop });
		// A classic scrollbar takes width from the content; hiding it hands that width back, the text
		// reflows and the scroll range changes under the position we are trying to keep. Pad it back.
		const gutter = el === document.documentElement ? window.innerWidth - el.clientWidth : el.offsetWidth - el.clientWidth - (parseFloat(getComputedStyle(el).borderLeftWidth) + parseFloat(getComputedStyle(el).borderRightWidth));
		const padding = parseFloat(getComputedStyle(el).paddingRight) || 0;
		el.style.overflow = "hidden";
		if (gutter > 0) el.style.paddingRight = `${padding + gutter}px`;
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		for (const el of held) {
			const entry = frozen.get(el);
			if (!entry) continue;
			if (--entry.count > 0) continue;
			frozen.delete(el);
			el.style.overflow = entry.overflow;
			el.style.paddingRight = entry.paddingRight;
			el.scrollTop = entry.scrollTop;
		}
	};
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
	return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
}

/**
 * Some openers are rebuilt while their overlay is up (a list that reloads, a row that remounts), so the
 * node that had focus is gone by the time the overlay closes. Remember which of its look-alikes it was —
 * same tag, same name, Nth in document order — so focus can go to its replacement instead of to <body>.
 */
function describe(el: HTMLElement) {
	const name = el.getAttribute("aria-label") ?? el.getAttribute("title") ?? el.textContent?.trim() ?? "";
	const twins = (): HTMLElement[] =>
		[...document.querySelectorAll<HTMLElement>(el.tagName)].filter((t) => (t.getAttribute("aria-label") ?? t.getAttribute("title") ?? t.textContent?.trim() ?? "") === name);
	return { index: Math.max(0, twins().indexOf(el)), twins };
}

/**
 * Call from the overlay's component with a ref to the dialog PANEL (not the scrim: the scrim's
 * close button is outside the dialog and must not be where focus lands or where Tab wraps to).
 * On mount: freeze the surrounding scroll owners, focus the first focusable control inside (the
 * panel itself if there is none), trap Tab. On unmount: restore the scroll owners and return focus
 * to whatever had it before, if that is still on the page.
 *
 * `focus: false` freezes the scroll owners and nothing else, for a surface that captures the
 * keyboard itself (the live remote browser forwards Tab to the page it is driving).
 */
export function useModalLock(ref: RefObject<HTMLElement | null>, { focus = true }: { focus?: boolean } = {}): void {
	// Read during the FIRST RENDER, not in the effect: the render that opens the overlay is often the same
	// commit that rebuilds the list its opener sits in, and by the time an effect runs the opener is gone
	// and <body> has focus. Render runs before any of that commit's DOM changes.
	const [origin] = useState(() => {
		if (typeof document === "undefined") return { opener: null, remembered: null }; // server render
		const active = document.activeElement;
		const opener = active instanceof HTMLElement && active !== document.body ? active : null;
		return { opener, remembered: opener ? describe(opener) : null };
	});
	useEffect(() => {
		const panel = ref.current;
		if (!panel) return;
		if (!focus) return freezeScrollOwners(panel);
		const { opener, remembered } = origin;
		const release = freezeScrollOwners(panel);
		const first = focusables(panel)[0];
		if (first) first.focus({ preventScroll: true });
		else {
			panel.tabIndex = -1;
			panel.focus({ preventScroll: true });
		}
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Tab") return;
			const items = focusables(panel);
			if (items.length === 0) {
				e.preventDefault();
				return;
			}
			const head = items[0];
			const tail = items[items.length - 1];
			const at = document.activeElement;
			if (e.shiftKey && (at === head || !panel.contains(at))) {
				e.preventDefault();
				tail.focus({ preventScroll: true });
			} else if (!e.shiftKey && (at === tail || !panel.contains(at))) {
				e.preventDefault();
				head.focus({ preventScroll: true });
			}
		};
		panel.addEventListener("keydown", onKeyDown);
		return () => {
			panel.removeEventListener("keydown", onKeyDown);
			release();
			if (!opener) return;
			const giveBack = () => {
				const twins = remembered?.twins() ?? [];
				const back = opener.isConnected ? opener : twins[Math.min(remembered?.index ?? 0, twins.length - 1)];
				back?.focus({ preventScroll: true });
			};
			giveBack();
			// The close itself can re-render the opener's list in the same commit or the next; if focus has
			// fallen to <body> by then, put it back once more rather than leave the keyboard user at the top.
			requestAnimationFrame(() => {
				if (document.activeElement === document.body || !document.activeElement) giveBack();
			});
		};
	}, [ref, focus, origin]);
}
