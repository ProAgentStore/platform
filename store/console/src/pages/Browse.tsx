import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import type { Instance } from "../lib/types";

/** Published-catalog agent (shape from GET /v1/agents). */
interface CatalogAgent {
	id: string;
	slug?: string;
	name: string;
	description?: string;
	category?: string;
	creator_login?: string;
	subscriber_count?: number;
}

/**
 * In-console agent marketplace: browse every PUBLISHED agent and subscribe to one
 * (creating a personal instance) without leaving the console. Anyone — including a
 * creator — can subscribe here; if you're already subscribed the card opens your
 * instance instead.
 */
export default function Browse() {
	const navigate = useNavigate();
	const [agents, setAgents] = useState<CatalogAgent[]>([]);
	const [instances, setInstances] = useState<Instance[]>([]);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const [cat, mine] = await Promise.all([
				api<{ agents: CatalogAgent[] }>("/v1/agents"),
				api<{ instances: Instance[] }>("/v1/instances/my/instances"),
			]);
			setAgents(cat.agents || []);
			setInstances(mine.instances || []);
		} catch (e) {
			console.error(e);
		}
		setLoading(false);
	}, []);
	useEffect(() => { load(); }, [load]);

	const instanceFor = (agentId: string) => instances.find((i) => i.agent_id === agentId);

	const subscribe = async (a: CatalogAgent, { fresh = false }: { fresh?: boolean } = {}) => {
		// Multiple instances of one agent are supported — "Open" goes to the existing
		// one; "+ New" (fresh) subscribes again (auto-named "Agent 2", renameable in
		// its Settings).
		const existing = instanceFor(a.id);
		if (existing && !fresh) { navigate(`/instances/${existing.id}`); return; }
		setBusy(a.id);
		try {
			const r = await api<{ instanceId: string }>(`/v1/instances/${a.id}/subscribe`, { method: "POST" });
			navigate(`/instances/${r.instanceId}`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			// Free-tier cap / Pro-only feature: offer the one-tap path to Billing.
			if (/Pro|\$9/.test(msg)) {
				if (confirm(`${msg}\n\nOpen billing?`)) navigate("/profile");
				return;
			}
			alert(msg);
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="max-w-[960px] mx-auto px-3 py-3 sm:px-6 sm:py-5">
			<div className="flex justify-between items-center mb-1">
				<h2 className="text-[1.1rem] font-semibold">Browse agents</h2>
			</div>
			<p className="text-sm text-muted mb-4">Subscribe to any published agent to get your own private instance.</p>
			{loading ? (
				<p className="text-center py-8 text-muted">Loading catalog…</p>
			) : agents.length === 0 ? (
				<p className="text-center py-8 text-muted-soft">No published agents yet.</p>
			) : (
				<div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-3">
					{agents.map((a) => {
						const sub = instanceFor(a.id);
						return (
							<div key={a.id} className="bg-panel border border-line rounded-xl p-3 sm:p-4 flex flex-col">
								<h3 className="text-[0.95rem] font-bold mb-1">{a.name}</h3>
								<p className="text-sm text-muted mb-2 leading-relaxed line-clamp-3 flex-1">{a.description || "No description"}</p>
								<div className="flex gap-2 text-xs mb-3 flex-wrap">
									{a.category && <span className="px-1.5 py-0.5 rounded font-medium bg-accent-soft text-purple-400">{a.category}</span>}
									{a.creator_login && <span className="px-1.5 py-0.5 rounded font-medium bg-muted/15 text-muted">@{a.creator_login}</span>}
									{typeof a.subscriber_count === "number" && <span className="px-1.5 py-0.5 rounded font-medium bg-muted/15 text-muted">{a.subscriber_count} subscriber{a.subscriber_count === 1 ? "" : "s"}</span>}
								</div>
								<div className="flex gap-2">
									<button
										type="button"
										onClick={() => subscribe(a)}
										disabled={busy === a.id}
										className={`flex-1 text-sm px-3 py-1.5 rounded-xl font-semibold transition-all disabled:opacity-50 ${sub ? "border border-line text-accent hover:bg-accent/10" : "bg-accent text-white hover:bg-accent-hover active:scale-[0.97]"}`}
									>
										{busy === a.id ? "Subscribing…" : sub ? "Open →" : "Subscribe"}
									</button>
									{sub && (
										<button
											type="button"
											onClick={() => subscribe(a, { fresh: true })}
											disabled={busy === a.id}
											title="Create another instance of this agent (own documents, settings, memory)"
											className="text-sm px-3 py-1.5 rounded-xl font-semibold border border-line text-muted hover:border-accent hover:text-accent transition-all disabled:opacity-50"
										>
											+ New
										</button>
									)}
								</div>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
