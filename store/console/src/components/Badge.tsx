import type { ReactNode } from "react";
import { badgeClass } from "../lib/control-classes";
import { type StatusIntent, statusIntent } from "../lib/statusBadge";

/**
 * A status pill (#366).
 *
 * Two ways in, and they are not interchangeable. `status` is for a value that came from the
 * SERVER — a board item's state, a pipeline run's outcome — and routes through
 * `statusBadge.ts` so the colour follows from what the status MEANS. `tone` is for a label the
 * UI itself decides. A caller that has a status and picks a tone by hand is re-opening the
 * split #368 closed, where the same idea wore two different greens.
 */
export default function Badge({
	status,
	tone,
	className = "",
	title,
	children,
}: {
	status?: string;
	tone?: StatusIntent;
	className?: string;
	title?: string;
	children?: ReactNode;
}) {
	const resolved: StatusIntent = tone ?? (status === undefined ? "neutral" : statusIntent(status));
	return (
		<span className={badgeClass(resolved, className)} title={title}>
			{children ?? status}
		</span>
	);
}

