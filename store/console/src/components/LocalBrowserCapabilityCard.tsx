import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import { parseDomains } from "../lib/localBrowser";
import type { AgentLocalBrowserCapabilities, LocalBrowserCapabilityView, LocalBrowserEngine } from "../lib/types";
import Button from "./Button";
import Card from "./Card";

const input = "bg-paper border border-line rounded px-2 py-1 text-sm font-normal";
const LIMITS = [
	["maxMinutes", "Minutes", 60],
	["maxPages", "Pages", 200],
	["maxActions", "Actions", 1000],
	["maxConcurrent", "Concurrent", 3],
] as const;

/**
 * Agent Builder → the "Local CLI browser research" capability (#946): the defaults and CEILINGS
 * every subscriber's instance starts from. The server validates it (engines, limits within the
 * platform's, hostnames) and serves back the resolved block, which is what this card shows.
 */
export default function LocalBrowserCapabilityCard({ agentId, runtime }: { agentId: string; runtime: string }) {
	const [cap, setCap] = useState<LocalBrowserCapabilityView | null>(null);
	const [storedRuntime, setStoredRuntime] = useState<string | null>(null);
	const [allow, setAllow] = useState("");
	const [deny, setDeny] = useState("");
	const [msg, setMsg] = useState("");

	const show = useCallback((d: AgentLocalBrowserCapabilities) => {
		setStoredRuntime(d.runtime);
		setCap(d.localBrowser);
		setAllow((d.localBrowser?.allowDomains ?? []).join("\n"));
		setDeny((d.localBrowser?.denyDomains ?? []).join("\n"));
	}, []);
	// Reloaded when the runtime picker above is saved: the block only resolves for `local_browser`.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `runtime` is the reload trigger, not a value read here.
	useEffect(() => {
		api<AgentLocalBrowserCapabilities>(`/v1/agents/${agentId}/capabilities`)
			.then(show)
			.catch((e) => setMsg(e instanceof Error ? e.message : String(e)));
	}, [agentId, runtime, show]);

	if (runtime !== "local_browser") return null;
	if (storedRuntime !== "local_browser" || !cap) {
		return (
			<Card className="mb-4">
				<h3 className="text-base font-semibold mb-1">Local CLI browser research</h3>
				<p className="text-xs text-muted">Save the capabilities above with runtime local_browser, then set its defaults here.</p>
				{msg && <p className="text-xs text-danger mt-1">{msg}</p>}
			</Card>
		);
	}
	const set = (patch: Partial<LocalBrowserCapabilityView>) => setCap((c) => (c ? { ...c, ...patch } : c));
	const toggleEngine = (e: LocalBrowserEngine, on: boolean) => set({ engines: on ? [...new Set([...cap.engines, e])] : cap.engines.filter((x) => x !== e) });

	const save = async () => {
		setMsg("");
		try {
			const body = { localBrowser: { ...cap, allowDomains: parseDomains(allow), denyDomains: parseDomains(deny) } };
			show(await api<AgentLocalBrowserCapabilities>(`/v1/agents/${agentId}/capabilities`, { method: "PUT", body: JSON.stringify(body) }));
			setMsg("Saved.");
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
	};

	return (
		<Card className="mb-4">
			<h3 className="text-base font-semibold mb-1">Local CLI browser research</h3>
			<p className="text-xs text-muted mb-3">
				Uses Codex or Claude Code signed into your subscriber's own machine to research in a real browser. PAGS supervises — it keeps each run, asks the owner before a new site, and stores only findings they approve; the local CLI drives the browser. Research only: no forms, applications or messages.
			</p>
			<div className="flex flex-col gap-3">
				<div className="flex gap-3 flex-wrap text-sm">
					<span className="text-xs font-semibold">Engines</span>
					{(["claude", "codex"] as const).map((e) => (
						<label key={e} className="flex items-center gap-1.5">
							<input type="checkbox" checked={cap.engines.includes(e)} onChange={(ev) => toggleEngine(e, ev.target.checked)} /> {e === "claude" ? "Claude Code" : "Codex"}
						</label>
					))}
				</div>
				<label className="flex items-center gap-1.5 text-sm">
					<input type="checkbox" checked={cap.subscriptionOnly} onChange={(e) => set({ subscriptionOnly: e.target.checked })} /> Subscription sign-in only (never a per-token API key)
				</label>
				<div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
					{LIMITS.map(([key, label, max]) => (
						<label key={key} className="flex flex-col gap-1 text-xs font-semibold">
							{label}
							<input className={input} type="number" min={1} max={max} value={cap.limits[key]} onChange={(e) => set({ limits: { ...cap.limits, [key]: Number(e.target.value) } })} />
						</label>
					))}
				</div>
				<div className="grid sm:grid-cols-2 gap-2">
					<label className="flex flex-col gap-1 text-xs font-semibold">
						Allowed sites <span className="font-normal text-muted">Empty = any public site, each asked about first.</span>
						<textarea className={input} rows={3} value={allow} onChange={(e) => setAllow(e.target.value)} />
					</label>
					<label className="flex flex-col gap-1 text-xs font-semibold">
						Never visit
						<textarea className={input} rows={3} value={deny} onChange={(e) => setDeny(e.target.value)} />
					</label>
				</div>
				<div className="grid sm:grid-cols-3 gap-2">
					<label className="flex flex-col gap-1 text-xs font-semibold">
						Results collection
						<input className={input} value={cap.collection?.name ?? ""} placeholder="job_leads" onChange={(e) => set({ collection: e.target.value ? { ...cap.collection, name: e.target.value } : undefined })} />
					</label>
					<label className="flex flex-col gap-1 text-xs font-semibold">
						Duplicate key
						<input className={input} value={cap.collection?.keyField ?? ""} placeholder="url" disabled={!cap.collection} onChange={(e) => cap.collection && set({ collection: { ...cap.collection, keyField: e.target.value || undefined } })} />
					</label>
					<label className="flex flex-col gap-1 text-xs font-semibold">
						Result schema
						<span className="flex gap-1">
							<input className={`${input} flex-1 min-w-0`} value={cap.resultSchema.id} onChange={(e) => set({ resultSchema: { ...cap.resultSchema, id: e.target.value } })} />
							<input className={`${input} w-16`} type="number" min={1} value={cap.resultSchema.version} aria-label="Result schema version" onChange={(e) => set({ resultSchema: { ...cap.resultSchema, version: Number(e.target.value) } })} />
						</span>
					</label>
				</div>
				<div className="flex gap-2 items-center">
					<Button variant="primary" onClick={save}>
						Save research defaults
					</Button>
					{msg && <span className={`text-xs ${msg === "Saved." ? "text-success" : "text-danger"}`}>{msg}</span>}
				</div>
			</div>
		</Card>
	);
}
