import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { KeyRound } from "lucide-react";
import { api } from "@proagentstore/sdk/client";
import type { ListSecureInputsResponse, SecureInputView } from "../lib/types";
import { ownerWaiting, secureInputBannerText } from "../lib/secureInput";

/**
 * "An agent is waiting for you to enter a value" — on every instance tab, not only chat (#934).
 *
 * The full list (`SecureInputRequests`) lives on the chat tab, so a request made while the owner was
 * on Coding, Board or Settings sat unseen for up to a day while the run that asked for it waited.
 * This polls the same list the chat tab does and, when anything waits on the owner, says so with a
 * link straight to the oldest request's entry page.
 */
export default function SecureInputBanner({ instanceId }: { instanceId: string }) {
	const [waiting, setWaiting] = useState<SecureInputView[]>([]);
	const load = useCallback(async () => {
		try {
			const res = await api<ListSecureInputsResponse>(`/v1/instances/${instanceId}/secure-inputs`);
			setWaiting(ownerWaiting(res.requests ?? []));
		} catch {
			// The next poll tries again; a failed read must not invent or clear a request.
		}
	}, [instanceId]);
	useEffect(() => {
		void load();
		const t = setInterval(() => void load(), 20_000);
		return () => clearInterval(t);
	}, [load]);

	if (waiting.length === 0) return null;
	const first = waiting[0];
	return (
		<div role="status" data-testid="secure-input-banner" className="flex flex-wrap items-center gap-x-3 gap-y-1 mx-2 mt-2 px-3 py-2 text-xs border border-warning bg-warning-soft text-warning rounded-lg">
			<KeyRound size={14} className="shrink-0" aria-hidden="true" />
			<span className="flex-1 min-w-0 [overflow-wrap:anywhere]">{secureInputBannerText(waiting)}</span>
			<Link to={`/instances/${encodeURIComponent(instanceId)}/secure-inputs/${encodeURIComponent(first.id)}`} className="font-semibold underline hover:no-underline">Enter it</Link>
			{waiting.length > 1 && <Link to={`/instances/${encodeURIComponent(instanceId)}/chat`} className="font-semibold underline hover:no-underline">See all {waiting.length}</Link>}
		</div>
	);
}
