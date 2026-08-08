import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { Empty, ErrorBox, Loading, Panel } from "../lib/ui";

interface RawErr { id: string; created_at: string; user_id: string | null; source: string; status: number | null; message: string; context: string | null }
interface Signature { key: string; source: string; sample: string; pattern: string; count: number; users: number; firstSeen: string; lastSeen: string; lastStatus: number | null; lastId: string }

const RANGES = [{ v: "1", l: "24h" }, { v: "7", l: "7d" }, { v: "30", l: "30d" }, { v: "", l: "All" }];
const statusColor = (s: number | null) => (s == null ? "text-muted" : s >= 500 ? "text-red" : s >= 400 ? "text-yellow" : "text-muted");

export default function Errors() {
	const [view, setView] = useState<"grouped" | "feed">("grouped");
	const [since, setSince] = useState("7");
	const [source, setSource] = useState("");
	const [q, setQ] = useState("");
	const [qDebounced, setQDebounced] = useState("");
	const [sigs, setSigs] = useState<Signature[] | null>(null);
	const [feed, setFeed] = useState<RawErr[] | null>(null);
	const [err, setErr] = useState("");
	const [openSig, setOpenSig] = useState<Signature | null>(null);
	const navigate = useNavigate();
	void openSig; void setOpenSig; // drawer retained but grouped rows now deep-link to the signature page

	useEffect(() => { const t = setTimeout(() => setQDebounced(q.trim()), 300); return () => clearTimeout(t); }, [q]);

	const qs = useMemo(() => {
		const p = new URLSearchParams();
		if (since) p.set("since", since);
		if (source) p.set("source", source);
		if (qDebounced) p.set("q", qDebounced);
		return p.toString();
	}, [since, source, qDebounced]);

	useEffect(() => {
		setErr("");
		if (view === "grouped") {
			setSigs(null);
			api<{ signatures: Signature[] }>(`/v1/admin/errors/summary${qs ? `?${qs}` : ""}`).then((r) => setSigs(r.signatures)).catch((e) => setErr(e.message));
		} else {
			setFeed(null);
			api<{ errors: RawErr[] }>(`/v1/admin/errors${qs ? `?${qs}` : ""}`).then((r) => setFeed(r.errors)).catch((e) => setErr(e.message));
		}
	}, [view, qs]);

	// Source options: derive from whatever we've loaded (best-effort).
	const sources = useMemo(() => {
		const s = new Set<string>();
		(sigs || []).forEach((x) => {
			s.add(x.source);
		});
		(feed || []).forEach((x) => {
			s.add(x.source);
		});
		return [...s].sort();
	}, [sigs, feed]);

	return (
		<div>
			<h1 className="font-display text-xl font-bold mb-1">Errors &amp; Exceptions</h1>
			<p className="text-sm text-muted mb-4">Grouped signatures show recurring failures — learn from what breaks most, then fix it.</p>

			<div className="flex flex-wrap items-center gap-2 mb-4">
				<div className="inline-flex rounded-lg border border-line overflow-hidden text-sm">
					<button type="button" onClick={() => setView("grouped")} className={`px-3 py-1.5 ${view === "grouped" ? "bg-accent text-white" : "text-muted hover:bg-panel-hover"}`}>Grouped</button>
					<button type="button" onClick={() => setView("feed")} className={`px-3 py-1.5 ${view === "feed" ? "bg-accent text-white" : "text-muted hover:bg-panel-hover"}`}>Feed</button>
				</div>
				<select aria-label="Time range" value={since} onChange={(e) => setSince(e.target.value)} className="!w-auto text-sm">
					{RANGES.map((r) => <option key={r.l} value={r.v}>{r.l}</option>)}
				</select>
				<select aria-label="Filter by source" value={source} onChange={(e) => setSource(e.target.value)} className="!w-auto text-sm">
					<option value="">All sources</option>
					{sources.map((s) => <option key={s} value={s}>{s}</option>)}
				</select>
				<input aria-label="Search error messages" placeholder="Search message…" value={q} onChange={(e) => setQ(e.target.value)} className="!w-auto flex-1 min-w-[160px] text-sm" />
			</div>

			{err ? <ErrorBox message={err} /> : view === "grouped" ? (
				!sigs ? <Loading /> : !sigs.length ? <Empty label="No errors in this window. 🎉" /> : (
					<Panel>
						<div className="overflow-x-auto">
							<table className="w-full text-sm">
								<thead><tr className="text-muted text-xs uppercase text-left border-b border-line">
									<th className="py-1.5">Count</th><th>Source</th><th>Signature</th><th>Users</th><th>Last seen</th>
								</tr></thead>
								<tbody>
									{/* The signature cell is the control, not the row (#324). A <tr onClick> is
									    reachable by mouse and by nothing else — no tab stop, no Enter, and a
									    screen reader announces a row with no action in it. Moving the click onto
									    the text you read to decide keeps the same target for the mouse. */}
									{sigs.map((s) => (
										<tr key={s.key} className="border-b border-line/50 hover:bg-panel-hover align-top">
											<td className="py-1.5 font-semibold">{s.count}×</td>
											<td className="text-accent whitespace-nowrap">{s.source}</td>
											<td className="max-w-[420px]">
												<button type="button" className="w-full text-left cursor-pointer" onClick={() => navigate(`/errors/${encodeURIComponent(s.key)}`)}>
													<div className="truncate">{s.sample}</div>
													<div className="text-xs text-muted-soft truncate">{s.pattern}</div>
												</button>
											</td>
											<td>{s.users}</td>
											<td className="text-muted whitespace-nowrap">{s.lastSeen?.slice(5, 16)}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</Panel>
				)
			) : (
				!feed ? <Loading /> : !feed.length ? <Empty label="No errors in this window." /> : (
					<Panel>
						<div className="space-y-1.5">
							{feed.map((e) => <FeedRow key={e.id} e={e} />)}
						</div>
					</Panel>
				)
			)}

			{openSig && <SignatureDrawer sig={openSig} qs={qs} onClose={() => setOpenSig(null)} />}
		</div>
	);
}

function FeedRow({ e }: { e: RawErr }) {
	const [open, setOpen] = useState(false);
	const toggle = () => setOpen(!open);
	return (
		<div className="border-b border-line/50 pb-1.5">
			<button type="button" className="w-full text-left flex gap-2 text-xs text-muted cursor-pointer" onClick={toggle}>
				<span>{e.created_at?.slice(5, 16)}</span>
				<span className="text-accent">{e.source}</span>
				{e.status != null && <span className={statusColor(e.status)}>{e.status}</span>}
				{e.user_id && <span className="truncate max-w-[140px]">{e.user_id}</span>}
			</button>
			<button type="button" className="w-full text-left break-words text-sm cursor-pointer" onClick={toggle}>{e.message}</button>
			{open && e.context && <ContextBlock context={e.context} />}
		</div>
	);
}

function SignatureDrawer({ sig, qs, onClose }: { sig: Signature; qs: string; onClose: () => void }) {
	const [rows, setRows] = useState<RawErr[] | null>(null);
	useEffect(() => {
		// Fetch recent occurrences for this source + text, then filter client-side to the pattern.
		const p = new URLSearchParams(qs);
		p.set("source", sig.source);
		p.set("limit", "200");
		api<{ errors: RawErr[] }>(`/v1/admin/errors?${p.toString()}`).then((r) => setRows(r.errors)).catch(() => setRows([]));
	}, [sig, qs]);
	return (
		<div className="fixed inset-0 flex justify-end z-50">
			<button type="button" aria-label="Close drawer" className="absolute inset-0 bg-black/60" onClick={onClose} />
			<div className="relative bg-panel border-l border-line w-full max-w-2xl h-dvh overflow-y-auto p-5">
				<div className="flex items-start justify-between mb-2">
					<div>
						<div className="text-xs text-accent">{sig.source}</div>
						<h2 className="font-semibold">{sig.sample}</h2>
					</div>
					<button type="button" onClick={onClose} className="text-muted hover:text-ink text-xl leading-none">×</button>
				</div>
				<div className="text-sm text-muted mb-4">
					<b className="text-ink">{sig.count}×</b> · {sig.users} user(s) · first {sig.firstSeen?.slice(0, 16)} · last {sig.lastSeen?.slice(0, 16)}
				</div>
				<div className="text-xs uppercase text-muted mb-1">Recent occurrences</div>
				{!rows ? <Loading /> : (
					<div className="space-y-2">
						{rows.map((e) => (
							<div key={e.id} className="border border-line rounded-lg p-2 text-sm">
								<div className="flex gap-2 text-xs text-muted mb-1">
									<span>{e.created_at?.slice(0, 16)}</span>
									{e.status != null && <span className={statusColor(e.status)}>{e.status}</span>}
									{e.user_id && <span className="truncate max-w-[160px]">{e.user_id}</span>}
								</div>
								<div className="break-words mb-1">{e.message}</div>
								{e.context && <ContextBlock context={e.context} />}
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function ContextBlock({ context }: { context: string }) {
	let pretty = context;
	try { pretty = JSON.stringify(JSON.parse(context), null, 2); } catch { /* raw */ }
	return <pre className="text-xs bg-paper border border-line rounded p-2 mt-1 overflow-x-auto whitespace-pre-wrap max-h-72 overflow-y-auto font-mono text-muted">{pretty}</pre>;
}
