import type { ReactNode } from "react";

/**
 * An empty-state card (#187) — lifted from the Stats tab: a centred icon, a title, any body the
 * caller writes, and an optional action. The words are the caller's; an empty page is often the
 * first thing a person sees, so the block does not supply defaults.
 */
export function EmptyState({
	icon,
	title,
	children,
	action,
}: {
	icon?: ReactNode;
	title: string;
	children?: ReactNode;
	action?: ReactNode;
}) {
	return (
		<div className="text-center py-10 px-4 bg-panel border border-line rounded-xl">
			{icon && <div className="flex justify-center text-muted-soft mb-2">{icon}</div>}
			<div className="font-semibold text-sm">{title}</div>
			{children}
			{action}
		</div>
	);
}
