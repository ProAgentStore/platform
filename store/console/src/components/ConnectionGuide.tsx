/**
 * The per-instance connection guide (#772), on the instance's own page.
 *
 * The MCP tool and this panel serve the same document to two audiences, and this is the half that
 * needs no MCP client at all: an owner wiring a fresh Claude or Codex session against this
 * instance copies the guide and pastes it into that assistant's system instructions. #753 settled
 * the placement rule — global text belongs on /console/tools, per-instance text belongs here —
 * and this is the per-instance case.
 *
 * The console renders what the server sends and adds nothing. A guide assembled here would be a
 * second renderer, and the second one drifts; `lib/connection-guide.ts` is the only one.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import type { ConnectionGuideResponse } from "../lib/types";
import Button from "./Button";
import Card from "./Card";
import LoadFailed from "./LoadFailed";

export default function ConnectionGuide({ instanceId, active }: { instanceId: string; active: boolean }) {
	const [guide, setGuide] = useState("");
	const [loading, setLoading] = useState(false);
	const [err, setErr] = useState("");
	const [copied, setCopied] = useState(false);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const d = await api<ConnectionGuideResponse>(`/v1/instances/${instanceId}/connection-guide`);
			setGuide(d.guide || "");
			setErr("");
		} catch (e) {
			// Reported, never swallowed: a blank panel where a guide should be reads as "this
			// instance exposes nothing", which is a statement about the agent rather than about a
			// failed fetch — the same empty-state confusion VectorsSection carries a note about.
			setErr(e instanceof Error ? e.message : String(e));
		}
		setLoading(false);
	}, [instanceId]);

	useEffect(() => {
		if (active) load();
	}, [active, load]);

	const copy = () => {
		void navigator.clipboard?.writeText(guide).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		});
	};

	return (
		<Card>
			<div className="flex items-center justify-between gap-3 mb-3">
				<div>
					<h3 className="text-sm font-semibold">Connection guide</h3>
					<p className="text-xs text-muted mt-0.5">
						How to drive this instance over MCP — its id, its tools and their exact field names, and a
						worked call example. Paste it into another assistant's instructions.
					</p>
				</div>
				<div className="flex items-center gap-2 shrink-0">
					<Button onClick={load} disabled={loading}>
						{loading ? "Loading…" : "Refresh"}
					</Button>
					<Button onClick={copy} disabled={!guide}>
						{copied ? "Copied" : "Copy"}
					</Button>
				</div>
			</div>

			{err ? (
				<LoadFailed what="this instance's connection guide" detail={err} onRetry={load} testId="connection-guide-load-failed" />
			) : (
				<>
					{/* Generated per call, never stored — so the panel says so rather than letting a reader
					    treat a copied guide as durable. */}
					<p className="text-2xs text-muted-soft mb-2">
						Generated fresh each time from live state. Re-copy it after changing tools, repos or the
						operator manual.
					</p>
					<pre className="text-xs whitespace-pre-wrap break-words bg-paper border border-line rounded p-3 max-h-[28rem] overflow-auto">
						{guide || (loading ? "" : "No guide yet — press Refresh.")}
					</pre>
				</>
			)}
		</Card>
	);
}
