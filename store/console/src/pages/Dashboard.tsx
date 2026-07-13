import { useState, useEffect, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import type { Agent, Instance } from "../lib/types";
import { platformToolGroups } from "../lib/platformTools";

export default function Dashboard() {
	const location = useLocation();
	const tab = location.pathname.includes("/instances") ? "instances" : location.pathname.includes("/tools") ? "tools" : location.pathname.includes("/dashboard") ? "dashboard" : "agents";
	const [agents, setAgents] = useState<Agent[]>([]);
	const [instances, setInstances] = useState<Instance[]>([]);
	const [loading, setLoading] = useState(true);
	const [stats, setStats] = useState<Record<string, unknown> | null>(null);
	const navigate = useNavigate();

	const loadAgents = useCallback(async () => {
		try {
			const data = await api<{ agents: Agent[] }>("/v1/agents/my/agents");
			setAgents(data.agents || []);
		} catch (e) {
			console.error(e);
		}
	}, []);

	const loadInstances = useCallback(async () => {
		try {
			const data = await api<{ instances: Instance[] }>("/v1/instances/my/instances");
			setInstances(data.instances || []);
		} catch (e) {
			console.error(e);
		}
	}, []);

	const loadDashboard = useCallback(async () => {
		try {
			const [creator, usage] = await Promise.all([
				api<Record<string, unknown>>("/v1/dashboard/creator"),
				api<Record<string, unknown>>("/v1/dashboard/usage"),
			]);
			setStats({ ...creator, ...usage });
		} catch {}
	}, []);

	// Load agents + instances once on mount
	useEffect(() => {
		(async () => {
			setLoading(true);
			await Promise.all([loadAgents(), loadInstances()]);
			setLoading(false);
		})();
	}, [loadAgents, loadInstances]);

	// Load dashboard stats only when that tab is active
	useEffect(() => {
		if (tab === "dashboard") loadDashboard();
	}, [tab, loadDashboard]);

	return (
		<div className="max-w-[960px] mx-auto px-3 py-3 sm:px-6 sm:py-5">
			{/* Agents */}
			{tab === "agents" && (
				<div>
					<div className="flex justify-between items-center mb-4">
						<h2 className="text-[1.1rem] font-semibold">Agents you've built</h2>
						<button type="button" onClick={() => navigate("/agents/new")} className="text-sm px-3 py-1.5 rounded-xl bg-accent text-white font-semibold hover:bg-accent-hover active:scale-[0.97] transition-all">+ New Agent</button>
					</div>
					{loading ? (
						<p className="text-center py-8 text-muted">Loading agents...</p>
					) : agents.length === 0 ? (
						<p className="text-center py-8 text-muted-soft">No agents yet. Create your first one!</p>
					) : (
						<div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-3">
							{agents.map((a) => (
								<button key={a.id} type="button" onClick={() => navigate(`/agents/${a.id}`)}
									className="text-left bg-panel border border-line rounded-xl p-3 sm:p-4 cursor-pointer transition-all hover:border-accent hover:-translate-y-px hover:shadow-lg">
									<h3 className="text-[0.95rem] font-bold mb-1">{a.name}</h3>
									<p className="text-sm text-muted mb-2 leading-relaxed line-clamp-2">{a.description || "No description"}</p>
									<div className="flex gap-2 text-xs">
										<span className={`px-1.5 py-0.5 rounded font-medium ${tagClass(a.visibility)}`}>{a.visibility}</span>
										<span className={`px-1.5 py-0.5 rounded font-medium ${tagClass(a.status)}`}>{a.status || "inactive"}</span>
										<span className="px-1.5 py-0.5 rounded font-medium bg-accent-soft text-purple-400">{a.category}</span>
									</div>
								</button>
							))}
						</div>
					)}
				</div>
			)}

			{/* Instances */}
			{tab === "instances" && (
				<div>
					<div className="flex justify-between items-center mb-4">
						<h2 className="text-[1.1rem] font-semibold">Agents you've subscribed to</h2>
						<button type="button" onClick={() => navigate("/browse")} className="text-sm px-3 py-1.5 rounded-xl border border-line text-muted hover:border-accent hover:text-accent font-semibold transition-all">Browse agents</button>
					</div>
					{loading ? (
						<p className="text-center py-8 text-muted">Loading instances...</p>
					) : instances.length === 0 ? (
						<p className="text-center py-8 text-muted-soft">No subscriptions yet. <button type="button" onClick={() => navigate("/browse")} className="text-accent underline">Browse agents</button> to subscribe.</p>
					) : (
						<div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-3">
							{instances.map((inst) => (
								<button key={inst.id} type="button" onClick={() => navigate(`/instances/${inst.id}`)}
									className="text-left bg-panel border border-line rounded-xl p-3 sm:p-4 cursor-pointer transition-all hover:border-accent hover:-translate-y-px hover:shadow-lg">
									<h3 className="text-[0.95rem] font-bold mb-1">{inst.name}</h3>
									<p className="text-sm text-muted mb-2 leading-relaxed line-clamp-2">{inst.description || "No description"}</p>
									<div className="flex gap-2 text-xs">
										<span className="px-1.5 py-0.5 rounded font-medium bg-green/15 text-green">subscribed</span>
									</div>
								</button>
							))}
						</div>
					)}
				</div>
			)}

			{/* Stats dashboard */}
			{tab === "dashboard" && (
				<div>
					<h2 className="text-[1.1rem] font-semibold mb-4">Platform Dashboard</h2>
					{!stats ? (
						<p className="text-center py-8 text-muted">Loading stats...</p>
					) : (
						<div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3 mb-6">
							{[["My Agents", stats.totalAgents], ["Total Subscribers", stats.totalSubscribers], ["Total Usage", stats.totalUsage], ["My Instances", stats.activeInstances]].map(([label, val]) => (
								<div key={String(label)} className="bg-panel border border-line rounded-xl p-4 text-center">
									<div className="text-2xl font-bold">{String(val || 0)}</div>
									<div className="text-xs text-muted">{String(label)}</div>
								</div>
							))}
						</div>
					)}
				</div>
			)}

			{/* Platform tools */}
			{tab === "tools" && (
				<div>
					<div className="mb-4">
						<h2 className="text-[1.1rem] font-semibold">Platform Tools</h2>
						<p className="text-sm text-muted mt-1 leading-relaxed">
							Tools are capability-gated. Coder, Repo Chat, generic agents, connectors, triggers, and MCP clients each see the tools they can actually use.
						</p>
					</div>
					<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
						{platformToolGroups.map((group) => (
							<section key={group.title} className="bg-panel border border-line rounded-lg p-3 sm:p-4">
								<div className="flex items-start justify-between gap-3 mb-3">
									<div className="min-w-0">
										<h3 className="text-[0.95rem] font-bold">{group.title}</h3>
										<p className="text-xs text-muted mt-1 leading-relaxed">{group.description}</p>
									</div>
									<span className="shrink-0 text-[0.68rem] px-2 py-1 rounded-md bg-line text-muted font-semibold whitespace-nowrap">{group.scope}</span>
								</div>
								<div className="divide-y divide-line/80">
									{group.tools.map((tool) => (
										<div key={tool.name} className="py-2 first:pt-0 last:pb-0">
											<div className="flex items-start justify-between gap-2">
												<code className="text-[0.76rem] text-ink bg-line/60 px-1.5 py-0.5 rounded break-all">{tool.name}</code>
												{tool.status && (
													<span className="text-[0.65rem] text-muted-soft border border-line rounded px-1.5 py-0.5 whitespace-nowrap">{tool.status}</span>
												)}
											</div>
											<p className="text-xs text-muted mt-1 leading-relaxed">{tool.description}</p>
										</div>
									))}
								</div>
							</section>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

function tagClass(value: string): string {
	switch (value) {
		case "draft": return "bg-yellow/15 text-yellow";
		case "unlisted": return "bg-blue/15 text-blue";
		case "published": case "active": return "bg-green/15 text-green";
		case "error": return "bg-red/15 text-red";
		default: return "bg-muted/15 text-muted";
	}
}
