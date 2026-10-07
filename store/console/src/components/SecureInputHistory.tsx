import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import Button from "./Button";
import Card from "./Card";
import type { ListSecureInputsResponse, SecureInputView } from "../lib/types";
import { secureInputStatusLine } from "../lib/secureInput";

/**
 * Every secure input this agent has asked for or moved, newest first (#929 finding 8).
 *
 * The chat tab lists only what is still open, so once a handoff completed its "Moved from X to Y"
 * was reachable by deep link alone. This is that history — metadata only, as everywhere: the value
 * never reaches the console. Renders nothing for an agent that has never used one.
 */
export default function SecureInputHistory({ instanceId }: { instanceId: string }) {
	const [rows, setRows] = useState<SecureInputView[]>([]);
	const [total, setTotal] = useState(0);
	const [next, setNext] = useState<number | null>(null);
	const [error, setError] = useState("");

	const load = useCallback(
		async (offset: number) => {
			try {
				const res = await api<ListSecureInputsResponse>(`/v1/instances/${instanceId}/secure-inputs?status=all&offset=${offset}`);
				setRows((prev) => (offset === 0 ? res.requests ?? [] : [...prev, ...(res.requests ?? [])]));
				setTotal(res.total ?? 0);
				setNext(res.nextOffset ?? null);
				setError("");
			} catch (e) {
				setError(e instanceof Error ? e.message : "Could not load the history");
			}
		},
		[instanceId],
	);

	useEffect(() => {
		void load(0);
	}, [load]);

	if (!rows.length && !error) return null;
	return (
		<Card className="mb-3 sm:mb-4" data-testid="secure-input-history">
			<h3 className="text-base font-bold mb-1">Secure inputs</h3>
			<p className="text-sm text-muted mb-2">
				Values this agent asked you for, and files it moved between machines — {total} in all. The values themselves are never shown.
			</p>
			{error && <p className="text-xs text-danger mb-2">{error}</p>}
			<ul className="divide-y divide-line/60">
				{rows.map((r) => (
					<li key={r.id} className="py-1.5">
						<Link to={`/instances/${instanceId}/secure-inputs/${r.id}`} className="text-sm font-semibold no-underline hover:underline">
							{r.label}
						</Link>
						<div className="text-2xs text-muted-soft">{secureInputStatusLine(r)}</div>
					</li>
				))}
			</ul>
			{next !== null && (
				<Button size="sm" className="mt-2" onClick={() => void load(next)}>
					Show more
				</Button>
			)}
		</Card>
	);
}
