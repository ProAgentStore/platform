import { useState, useEffect, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { api } from "../lib/api";
import type { Agent, Instance } from "../lib/types";

export default function Dashboard() {
	const location = useLocation();
	const tab = location.pathname.includes("/instances") ? "instances" : location.pathname.includes("/dashboard") ? "dashboard" : "agents";
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

	useEffect(() => {
		(async () => {
			setLoading(true);
			await Promise.all([loadAgents(), loadInstances()]);
			if (tab === "dashboard") await loadDashboard();
			setLoading(false);
		})();
	}, [loadAgents, loadInstances, loadDashboard, tab]);

	return (
		<div className="max-w-[960px] mx-auto p-4 sm:p-6">
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
								<div key={a.id} onClick={() => navigate(`/agents/${a.id}`)} onKeyDown={(e) => { if (e.key === "Enter") navigate(`/agents/${a.id}`); }} role="button" tabIndex={0}
									className="bg-panel border border-line rounded-xl p-4 cursor-pointer transition-all hover:border-accent hover:-translate-y-px hover:shadow-lg">
									<h3 className="text-[0.95rem] font-bold mb-1">{a.name}</h3>
									<p className="text-sm text-muted mb-2 leading-relaxed line-clamp-2">{a.description || "No description"}</p>
									<div className="flex gap-2 text-xs">
										<span className={`px-1.5 py-0.5 rounded font-medium ${tagClass(a.visibility)}`}>{a.visibility}</span>
										<span className={`px-1.5 py-0.5 rounded font-medium ${tagClass(a.status)}`}>{a.status || "inactive"}</span>
										<span className="px-1.5 py-0.5 rounded font-medium bg-accent-soft text-purple-400">{a.category}</span>
									</div>
								</div>
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
						<a href="/" className="text-sm px-3 py-1.5 rounded-xl border border-line text-muted hover:border-accent hover:text-accent no-underline font-semibold transition-all">Browse Store</a>
					</div>
					{loading ? (
						<p className="text-center py-8 text-muted">Loading instances...</p>
					) : instances.length === 0 ? (
						<p className="text-center py-8 text-muted-soft">No subscriptions yet. Browse the <a href="/">store</a> to find agents.</p>
					) : (
						<div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-3">
							{instances.map((inst) => (
								<div key={inst.id} onClick={() => navigate(`/instances/${inst.id}`)} onKeyDown={(e) => { if (e.key === "Enter") navigate(`/instances/${inst.id}`); }} role="button" tabIndex={0}
									className="bg-panel border border-line rounded-xl p-4 cursor-pointer transition-all hover:border-accent hover:-translate-y-px hover:shadow-lg">
									<h3 className="text-[0.95rem] font-bold mb-1">{inst.name}</h3>
									<p className="text-sm text-muted mb-2 leading-relaxed line-clamp-2">{inst.description || "No description"}</p>
									<div className="flex gap-2 text-xs">
										<span className="px-1.5 py-0.5 rounded font-medium bg-green/15 text-green">subscribed</span>
									</div>
								</div>
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
