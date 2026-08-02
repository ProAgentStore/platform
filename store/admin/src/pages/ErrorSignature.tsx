import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { Empty, ErrorBox, Loading, Panel } from "../lib/ui";

interface RawErr { id: string; created_at: string; user_id: string | null; source: string; status: number | null; message: string; context: string | null }
interface Signature { key: string; source: string; sample: string; pattern: string; count: number; users: number; firstSeen: string; lastSeen: string; lastStatus: number | null; lastId: string }

const statusColor = (s: number | null) => (s == null ? "text-muted" : s >= 500 ? "text-red" : s >= 400 ? "text-yellow" : "text-muted");

/**
 * Mirror of the server's normalizeMessage (lib/admin-errors.ts) so we can filter the
 * raw feed down to exactly the occurrences that belong to this signature's pattern.
 */
function normalizeMessage(message: string): string {
	return (message || "")
		.toLowerCase()
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "{id}")
		.replace(/\b[0-9a-f]{16,}\b/g, "{id}")
		.replace(/"[^"]*"/g, '"{s}"')
		.replace(/\d+/g, "{n}")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 200);
}

export default function ErrorSignature() {
	const { key: rawKey } = useParams<{ key: string }>();
	const sigKey = rawKey ? decodeURIComponent(rawKey) : "";

	const [sig, setSig] = useState<Signature | null>(null);
	const [rows, setRows] = useState<RawErr[] | null>(null);
	const [err, setErr] = useState("");

	// 1) Fetch the summary and find the matching signature by key.
	useEffect(() => {
		let ignore = false;
		setErr("");
		setSig(null);
		api<{ signatures: Signature[] }>("/v1/admin/errors/summary")
			.then((r) => {
				if (ignore) return;
				const found = r.signatures.find((s) => s.key === sigKey) || null;
				if (!found) setErr("Signature not found — it may have aged out of the window.");
				setSig(found);
			})
			.catch((e) => { if (!ignore) setErr(e.message); });
		return () => { ignore = true; };
	}, [sigKey]);

	// 2) Once we have the signature, fetch recent raw occurrences for its source and
	//    client-side filter to those whose normalized message matches the pattern.
	//    The `ignore` guard prevents a slow response for a previous signature from
	//    overwriting the rows once the user has navigated to another.
	useEffect(() => {
		if (!sig) { setRows(null); return; }
		let ignore = false;
		setRows(null);
		const p = new URLSearchParams();
		p.set("source", sig.source);
		p.set("limit", "200");
		api<{ errors: RawErr[] }>(`/v1/admin/errors?${p.toString()}`)
			.then((r) => { if (!ignore) setRows(r.errors.filter((e) => normalizeMessage(e.message) === sig.pattern)); })
			.catch(() => { if (!ignore) setRows([]); });
		return () => { ignore = true; };
	}, [sig]);

	return (
		<div>
			<Link to="/errors" className="text-sm text-accent hover:underline">← Back to errors</Link>
			<h1 className="font-display text-xl font-bold mt-2 mb-1">Error signature</h1>

			{err ? <ErrorBox message={err} /> : !sig ? <Loading /> : (
				<>
					<Panel>
						<div className="text-xs text-accent">{sig.source}</div>
						<h2 className="font-semibold break-words mb-1">{sig.sample}</h2>
						<div className="text-xs text-muted-soft font-mono break-words mb-3">{sig.pattern}</div>
						<div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
							<div><div className="text-lg font-bold">{sig.count}×</div><div className="text-xs text-muted">Occurrences</div></div>
							<div><div className="text-lg font-bold">{sig.users}</div><div className="text-xs text-muted">User(s)</div></div>
							<div><div className={`text-lg font-bold ${statusColor(sig.lastStatus)}`}>{sig.lastStatus ?? "—"}</div><div className="text-xs text-muted">Last status</div></div>
							<div><div className="text-sm font-semibold whitespace-nowrap">{sig.lastSeen?.slice(0, 16)}</div><div className="text-xs text-muted">Last seen</div></div>
						</div>
						<div className="text-xs text-muted mt-3">First seen {sig.firstSeen?.slice(0, 16)}</div>
					</Panel>

					<div className="text-xs uppercase text-muted mb-2">Recent occurrences</div>
					{!rows ? <Loading /> : !rows.length ? <Empty label="No matching occurrences in the recent feed." /> : (
						<div className="space-y-2">
							{rows.map((e) => <OccurrenceRow key={e.id} e={e} />)}
						</div>
					)}
				</>
			)}
		</div>
	);
}

function OccurrenceRow({ e }: { e: RawErr }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="bg-panel border border-line rounded-xl p-3 text-sm">
			<div className="flex gap-2 text-xs text-muted mb-1">
				<span>{e.created_at?.slice(0, 16)}</span>
				{e.status != null && <span className={statusColor(e.status)}>{e.status}</span>}
				{e.user_id && <span className="truncate max-w-[160px]">{e.user_id}</span>}
			</div>
			<div className="break-words mb-1">{e.message}</div>
			{e.context && (
				<>
					<button type="button" onClick={() => setOpen(!open)} className="text-xs text-accent hover:underline">{open ? "Hide" : "Show"} context</button>
					{open && <ContextBlock context={e.context} />}
				</>
			)}
		</div>
	);
}

function ContextBlock({ context }: { context: string }) {
	let pretty = context;
	try { pretty = JSON.stringify(JSON.parse(context), null, 2); } catch { /* raw */ }
	return <pre className="text-xs bg-paper border border-line rounded p-2 mt-1 overflow-x-auto whitespace-pre-wrap max-h-72 overflow-y-auto font-mono text-muted">{pretty}</pre>;
}
