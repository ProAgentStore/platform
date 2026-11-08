/**
 * The per-instance connection guide (#772), on the instance's own page.
 *
 * The MCP tool and this row serve the same document to two audiences, and this is the half that
 * needs no MCP client at all: an owner wiring a fresh Claude or Codex session against this
 * instance copies the guide and pastes it into that assistant's system instructions. #753 settled
 * the placement rule — global text belongs on /console/tools, per-instance text belongs here —
 * and this is the per-instance case.
 *
 * The document is long and repeats the manual, so it is neither fetched on open nor rendered (#1596):
 * pressing Copy fetches it and puts it on the clipboard. Only if the clipboard refuses is it shown.
 *
 * The console adds nothing to what the server sends. A guide assembled here would be a second
 * renderer, and the second one drifts; `lib/connection-guide.ts` is the only one.
 */
import { useRef, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import type { ConnectionGuideResponse } from "../lib/types";
import Button from "./Button";
import Card from "./Card";
import LoadFailed from "./LoadFailed";

export default function ConnectionGuide({ instanceId }: { instanceId: string }) {
	const [copying, setCopying] = useState(false);
	const [copied, setCopied] = useState(false);
	const [err, setErr] = useState("");
	// Set when the clipboard refused: the guide is shown so the owner can still select it.
	const [shown, setShown] = useState<string | null>(null);
	const pending = useRef(false);

	const copy = async () => {
		if (pending.current) return;
		pending.current = true;
		setCopying(true); setCopied(false); setErr(""); setShown(null);
		// The clipboard write starts here, synchronously inside the click, with the fetch handed to it as a
		// Promise<Blob>: a writeText after an awaited fetch loses user activation in Safari/iOS.
		const guide = api<ConnectionGuideResponse>(`/v1/instances/${encodeURIComponent(instanceId)}/connection-guide`).then((d) => d.guide || "");
		let write: Promise<void> | null = null;
		try {
			if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
				write = navigator.clipboard.write([new ClipboardItem({ "text/plain": guide.then((t) => new Blob([t], { type: "text/plain" })) })]);
			}
		} catch {
			write = Promise.reject(new Error("clipboard write unavailable"));
		}
		write?.catch(() => {}); // judged below; a failed fetch also rejects it
		try {
			// Reported, never swallowed: a fetch failure is not a statement about the agent.
			let text: string;
			try {
				text = await guide;
			} catch (e) {
				setErr(e instanceof Error ? e.message : String(e));
				return;
			}
			try {
				if (!write) throw new Error("no ClipboardItem");
				await write;
			} catch {
				try {
					await navigator.clipboard.writeText(text);
				} catch {
					setShown(text);
					return;
				}
			}
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} finally {
			pending.current = false;
			setCopying(false);
		}
	};

	return (
		<Card>
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<h3 className="text-sm font-semibold">Connection guide</h3>
					<p className="text-xs text-muted mt-0.5">How to drive this instance over MCP — its id, its tools and their exact field names, and a worked call example.</p>
				</div>
				<Button onClick={() => void copy()} disabled={copying} className="shrink-0">
					{copying ? "Copying…" : copied ? "Copied" : "Copy guide"}
				</Button>
			</div>
			{err && (
				<div className="mt-3">
					<LoadFailed what="this instance's connection guide" detail={err} onRetry={() => void copy()} testId="connection-guide-load-failed" />
				</div>
			)}
			{shown !== null && (
				<div className="mt-3" data-testid="connection-guide-fallback">
					<p className="text-xs mb-2" role="status">Couldn't copy automatically — select the guide below and copy it.</p>
					<pre className="text-xs whitespace-pre-wrap break-words bg-paper border border-line rounded p-3 overflow-x-auto">{shown}</pre>
				</div>
			)}
		</Card>
	);
}
