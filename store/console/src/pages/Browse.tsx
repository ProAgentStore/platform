import { useState, useEffect, useCallback } from "react";
import Page from "../components/Page";
import { useNavigate } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import type { Instance } from "../lib/types";
import Card from "../components/Card";
import Button from "../components/Button";

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
	// The name form for a SECOND instance of an agent you already have: `{agentId, value}`.
	const [naming, setNaming] = useState<{ id: string; value: string } | null>(null);

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

	/**
	 * Subscribe, optionally under a name the user chose.
	 *
	 * "Open" goes to the existing instance; "+ New" asks for a NAME first (#450). It used to
	 * subscribe straight away and let the server call the result "Agent 2" — which is a uniqueness
	 * suffix, not something anyone says. Nobody can then ask to be transferred to it by voice:
	 * a transcriber writes "agent two", the roster holds "Agent 2", and nothing bridges them.
	 * The prompt is the fix, and it is one form rather than a smarter matcher.
	 */
	const subscribe = async (a: CatalogAgent, displayName?: string) => {
		setBusy(a.id);
		try {
			const r = await api<{ instanceId: string }>(`/v1/instances/${a.id}/subscribe`, {
				method: "POST",
				body: JSON.stringify(displayName ? { displayName } : {}),
			});
			setNaming(null);
			navigate(`/instances/${r.instanceId}`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			alert(msg);
		} finally {
			setBusy(null);
		}
	};

	/** The primary button: open what you already have, or subscribe for the first time. */
	const openOrSubscribe = (a: CatalogAgent) => {
		const existing = instanceFor(a.id);
		if (existing) { navigate(`/instances/${existing.id}`); return; }
		void subscribe(a);
	};

	return (
		<Page>
			<div className="flex justify-between items-center mb-1">
				<h2 className="text-lg font-semibold">Browse agents</h2>
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
							<Card key={a.id} className="flex flex-col">
								<h3 className="text-base font-bold mb-1">{a.name}</h3>
								<p className="text-sm text-muted mb-2 leading-relaxed line-clamp-3 flex-1">{a.description || "No description"}</p>
								<div className="flex gap-2 text-xs mb-3 flex-wrap">
									{a.category && <span className="px-1.5 py-0.5 rounded font-medium bg-accent-soft text-purple-400">{a.category}</span>}
									{a.creator_login && <span className="px-1.5 py-0.5 rounded font-medium bg-muted/15 text-muted">@{a.creator_login}</span>}
									{typeof a.subscriber_count === "number" && <span className="px-1.5 py-0.5 rounded font-medium bg-muted/15 text-muted">{a.subscriber_count} subscriber{a.subscriber_count === 1 ? "" : "s"}</span>}
								</div>
								{naming?.id === a.id ? (
									<form
										onSubmit={(e) => { e.preventDefault(); if (naming.value.trim()) void subscribe(a, naming.value.trim()); }}
										className="flex flex-col gap-2"
									>
										{/* Why a name is being asked for, in the terms it matters in: you can already
										    have several of these, and the one thing you cannot do with "Agent 2" is
										    say it. */}
										<label className="text-xs text-muted" htmlFor={`name-${a.id}`}>
											You already have one. Name this one something you would say out loud — an agent can transfer you by name.
										</label>
										<input
											id={`name-${a.id}`}
											value={naming.value}
											onChange={(e) => setNaming({ id: a.id, value: e.target.value })}
											placeholder="e.g. Ops repo"
											maxLength={60}
										/>
										<div className="flex gap-2">
											<Button type="submit" variant="primary" size="lg" className="flex-1" disabled={busy === a.id || !naming.value.trim()}>
												{busy === a.id ? "Subscribing…" : "Create"}
											</Button>
											<Button variant="secondary" size="lg" onClick={() => setNaming(null)}>
												Cancel
											</Button>
										</div>
									</form>
								) : (
									<div className="flex gap-2">
										<button
											type="button"
											onClick={() => openOrSubscribe(a)}
											disabled={busy === a.id}
											className={`flex-1 text-sm px-3 py-1.5 rounded-xl font-semibold transition-all disabled:opacity-50 ${sub ? "border border-line text-accent hover:bg-accent-soft" : "bg-accent text-white hover:bg-accent-hover active:scale-[0.97]"}`}
										>
											{busy === a.id ? "Subscribing…" : sub ? "Open →" : "Subscribe"}
										</button>
										{sub && (
											<button
												type="button"
												onClick={() => setNaming({ id: a.id, value: "" })}
												disabled={busy === a.id}
												title="Create another instance of this agent (own documents, settings, memory)"
												className="text-sm px-3 py-1.5 rounded-xl font-semibold border border-line text-muted hover:border-accent hover:text-accent transition-all disabled:opacity-50"
											>
												+ New
											</button>
										)}
									</div>
								)}
							</Card>
						);
					})}
				</div>
			)}
		</Page>
	);
}
