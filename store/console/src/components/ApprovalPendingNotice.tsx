import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

interface Pending {
	approval_id: string;
	action_label?: string;
}

/**
 * Shown whenever a change the owner just made was HELD by the account approval gate (#1268). The save that triggered it
 * looks like a success to the page that made it; this says what actually happened — nothing has changed yet — and links to
 * the exact request.
 */
export default function ApprovalPendingNotice() {
	const [pending, setPending] = useState<Pending | null>(null);
	useEffect(() => {
		const onPending = (event: Event) => setPending((event as CustomEvent<Pending>).detail);
		window.addEventListener("pags:approval-pending", onPending);
		return () => window.removeEventListener("pags:approval-pending", onPending);
	}, []);
	if (!pending) return null;
	return (
		<div role="status" className="flex items-center justify-between gap-3 border-b border-line bg-paper px-4 py-2 text-sm" data-testid="approval-pending-notice">
			<span>
				<strong>Waiting for your approval</strong> — {pending.action_label ?? "that change"} has not been applied. Approve it from your phone or in Preferences.
			</span>
			<span className="flex shrink-0 gap-3">
				<Link className="underline" to={`/preferences?approval=${encodeURIComponent(pending.approval_id)}`} onClick={() => setPending(null)}>Review</Link>
				<button type="button" className="underline" onClick={() => setPending(null)}>Dismiss</button>
			</span>
		</div>
	);
}
