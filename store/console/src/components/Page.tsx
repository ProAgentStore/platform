import type { ReactNode } from "react";

/**
 * The standard centered page container. Single source of truth for the
 * `w-full max-w-[N] mx-auto` pattern so no page can drop `w-full` again.
 *
 * Why `w-full` is mandatory: these divs are flex items of the `flex-col`
 * <main> (see Layout). `mx-auto` sets auto horizontal margins, which disable
 * cross-axis stretch — so WITHOUT a definite width the container sizes to its
 * max-content (~634px) and overflows the mobile viewport, putting a horizontal
 * scrollbar on <main>. `w-full` gives it width:100% so it shrinks to the
 * viewport on mobile while staying capped + centered on desktop.
 *
 * Sibling footgun (not this component): a flex CHILD that refuses to shrink
 * usually needs `min-w-0` (and `min-h-0` vertically).
 *
 * NOTE: only for centered, scrollable pages. Full-height pages (InstanceDetail
 * and its tabs) use a `flex-1 min-h-0` full-bleed layout and must NOT use this.
 */

// Static classes only — Tailwind's JIT can't see runtime-interpolated values.
const MAX_W = {
	960: "max-w-[960px]",
	1040: "max-w-[1040px]",
	1100: "max-w-[1100px]",
} as const;

export default function Page({
	width = 960,
	className = "",
	children,
}: {
	width?: keyof typeof MAX_W;
	className?: string;
	children: ReactNode;
}) {
	return (
		<div className={`w-full ${MAX_W[width]} mx-auto px-3 py-3 sm:px-6 sm:py-5 ${className}`}>
			{children}
		</div>
	);
}
