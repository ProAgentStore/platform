import { useState, useEffect, useCallback, useRef } from "react";
import Button from "../components/Button";
import Page from "../components/Page";
import LoadFailed from "../components/LoadFailed";
import { useNavigate, useLocation } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import type { Agent, Instance } from "../lib/types";
import { capabilityBadges, identityFor } from "../lib/identity";
import { INSTANCE_SORTS, INSTANCE_SORT_LABEL, type InstanceSort, agentOptions, listInstances, parseSort, rememberSort, rememberedSort } from "../lib/instanceList";
import { HEALTH_DOT, HEALTH_LABEL, HEALTH_TEXT, INSTANCE_HEALTHS, activityFor, healthCounts, outcomeLine, type InstanceHealth } from "../lib/instanceActivity";
import { useActivity } from "../hooks/useActivity";
import { platformToolGroups } from "../lib/platformTools";

type SurfaceDoc = {
	version: string;
	toolCount: number;
	instructions: string;
	guide: string;
};

export default function Dashboard() {
	const location = useLocation();
	const tab = location.pathname.includes("/instances") ? "instances" : location.pathname.includes("/tools") ? "tools" : location.pathname.includes("/dashboard") ? "dashboard" : "agents";
	const [agents, setAgents] = useState<Agent[]>([]);
	const [instances, setInstances] = useState<Instance[]>([]);
	const [loading, setLoading] = useState(true);
	const [stats, setStats] = useState<Record<string, unknown> | null>(null);
	const [surfaceDoc, setSurfaceDoc] = useState<SurfaceDoc | null>(null);
	const [surfaceErr, setSurfaceErr] = useState("");
	const [surfaceOpen, setSurfaceOpen] = useState(false);
	const [copied, setCopied] = useState<"instructions" | "guide" | null>(null);
	const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Type-to-filter over the instances already loaded (#795). Local to the tab and never
	// persisted: a filter that survived a reload would be a list silently missing rows, with the
	// reason parked in a box the user has long stopped looking at.
	const [instanceQuery, setInstanceQuery] = useState("");
	// Sort and agent filter (#815) — lib/instanceList.ts holds the rules. The agent filter follows
	// the search box and is not persisted; the sort hides nothing, so it is.
	const [instanceSort, setInstanceSort] = useState<InstanceSort>(rememberedSort);
	const [instanceAgent, setInstanceAgent] = useState("");
	// Status is a FILTER, so like the agent filter and the search box it is not persisted: a filter
	// that survived a reload is a list silently missing rows.
	const [instanceHealth, setInstanceHealth] = useState<InstanceHealth | "">("");
	// One call for the whole account, polled only while this tab is the one on screen (#815).
	const activity = useActivity(tab === "instances");
	const instanceAgents = agentOptions(instances);
	const healthTotals = healthCounts(instances, activity.byInstance);
	const visibleInstances = listInstances(instances, {
		query: instanceQuery,
		sort: instanceSort,
		agentId: instanceAgent,
		health: instanceHealth,
		activity: activity.byInstance,
	});
	const clearInstanceFilters = () => {
		setInstanceQuery("");
		setInstanceAgent("");
		setInstanceHealth("");
	};
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

	// A dashboard is read as a measurement, so a failed load showing the previous (or zero)
	// figures is not a blank — it is a WRONG number presented with the same authority as a right
	// one, and nothing on screen dates it (#291).
	const [statsErr, setStatsErr] = useState("");
	const loadDashboard = useCallback(async () => {
		try {
			const [creator, usage] = await Promise.all([
				api<Record<string, unknown>>("/v1/dashboard/creator"),
				api<Record<string, unknown>>("/v1/dashboard/usage"),
			]);
			setStats({ ...creator, ...usage });
			setStatsErr("");
		} catch (e) {
			setStatsErr(e instanceof Error ? e.message : String(e));
		}
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

	const loadSurface = useCallback(async () => {
		try {
			const res = await fetch("https://mcp.proagentstore.online/surface");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json() as SurfaceDoc;
			setSurfaceDoc(data);
			setSurfaceErr("");
		} catch (e) {
			setSurfaceErr(e instanceof Error ? e.message : String(e));
		}
	}, []);

	useEffect(() => {
		if (tab === "tools" && !surfaceDoc && !surfaceErr) loadSurface();
	}, [tab, surfaceDoc, surfaceErr, loadSurface]);

	function copyText(field: "instructions" | "guide", text: string) {
		void navigator.clipboard.writeText(text).then(() => {
			setCopied(field);
			if (copyTimer.current) clearTimeout(copyTimer.current);
			copyTimer.current = setTimeout(() => setCopied(null), 2000);
		});
	}

	return (
		<Page>
			{/* Agents */}
			{tab === "agents" && (
				<div>
					<div className="flex justify-between items-center mb-4">
						<h2 className="text-lg font-semibold">Agents you've built</h2>
						<Button variant="primary" size="lg" onClick={() => navigate("/agents/new")} className="active:scale-[0.97]">+ New Agent</Button>
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
									<h3 className="text-base font-bold mb-1">{a.name}</h3>
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
					{/* The primary action here is CREATE, not discover (#796, #798).
					    "Browse agents" was a secondary button that described a destination; this
					    describes what the user came to do, and matches "+ New Agent" on the Agents
					    tab so the two halves of the console read the same way.

					    It still lands on the Library, because subscribing IS how an instance is
					    created (`POST /v1/instances/:id/subscribe`) and `Browse.tsx` already holds
					    that flow, naming included (#450). A separate picker would be a second
					    subscribe surface to keep correct for no new capability. So #796 and #798
					    together are a relabelling, deliberately: the discovery framing goes, the
					    only route to a new instance stays. */}
					<div className="flex justify-between items-center mb-4">
						<h2 className="text-lg font-semibold">Agents you've subscribed to</h2>
						<Button variant="primary" size="lg" onClick={() => navigate("/browse")} className="active:scale-[0.97]">+ New instance</Button>
					</div>
					{/* Type-to-filter (#795), sort and agent filter (#815). lib/instanceSearch.ts holds
					    the matching and the reasons for its edges; lib/instanceList.ts composes it
					    with the other two.

					    Rendered only when there is something to filter. A box above "No instances
					    yet" offers to narrow an empty list, which is noise on precisely the account
					    that needs the create action instead — and it is the one account for which
					    the two empty states below would be indistinguishable. */}
					{!loading && instances.length > 0 && (
						<div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
							<input
								type="search"
								value={instanceQuery}
								onChange={(e) => setInstanceQuery(e.target.value)}
								aria-label="Filter instances by name"
								placeholder="Filter by name..."
								className="w-full sm:max-w-xs bg-paper border border-line rounded-lg px-3 py-2 text-sm"
							/>
							<label className="text-xs text-muted flex items-center gap-1.5">
								Sort
								<select
									value={instanceSort}
									onChange={(e) => {
										const next = parseSort(e.target.value);
										setInstanceSort(next);
										rememberSort(next);
									}}
									aria-label="Sort instances"
									className="bg-paper border border-line rounded-lg px-2 py-2 text-sm text-ink"
								>
									{INSTANCE_SORTS.map((s) => <option key={s} value={s}>{INSTANCE_SORT_LABEL[s]}</option>)}
								</select>
							</label>
							{/* One agent is nothing to choose between — the control would only ever say "All". */}
							{instanceAgents.length > 1 && (
								<label className="text-xs text-muted flex items-center gap-1.5 min-w-0">
									Agent
									<select
										value={instanceAgent}
										onChange={(e) => setInstanceAgent(e.target.value)}
										aria-label="Filter instances by agent"
										className="bg-paper border border-line rounded-lg px-2 py-2 text-sm text-ink min-w-0 max-w-[12rem]"
									>
										<option value="">All agents</option>
										{instanceAgents.map((a) => <option key={a.agentId} value={a.agentId}>{a.label} ({a.count})</option>)}
									</select>
								</label>
							)}
							{/* Status — a segmented control rather than a third select, matching BoardTab's
							    view toggle: four fixed choices are worth one tap, and the counts are the
							    part that makes the control readable before you use it.

							    Rendered only once the first poll has landed. Before that every instance
							    reads idle, so the control would offer three segments that match nothing
							    and blame the filter for it.

							    A zero-count segment stays VISIBLE but muted. Hiding it would reflow the
							    control every time a run starts or stops, which is a moving target on the
							    one screen whose job is to be glanced at. */}
							{activity.asOf > 0 && (
								<fieldset className="flex border border-line rounded-lg overflow-hidden min-w-0" aria-label="Filter instances by status">
									<button
										type="button"
										onClick={() => setInstanceHealth("")}
										aria-pressed={instanceHealth === ""}
										className={`px-2 py-1.5 text-xs font-bold ${instanceHealth === "" ? "bg-accent-soft text-accent" : "text-muted hover:bg-panel-hover"}`}
									>
										All
									</button>
									{INSTANCE_HEALTHS.map((h) => (
										<button
											key={h}
											type="button"
											onClick={() => setInstanceHealth(h)}
											aria-pressed={instanceHealth === h}
											title={`${HEALTH_LABEL[h]} (${healthTotals[h]})`}
											className={`px-2 py-1.5 text-xs font-bold whitespace-nowrap ${
												instanceHealth === h
													? "bg-accent-soft text-accent"
													: healthTotals[h] === 0
														? "text-muted-soft hover:bg-panel-hover"
														: "text-muted hover:bg-panel-hover"
											}`}
										>
											<span className="hidden sm:inline">{HEALTH_LABEL[h]} </span>
											<span className="sm:hidden">{HEALTH_LABEL[h].slice(0, 1)}</span>
											{healthTotals[h]}
										</button>
									))}
								</fieldset>
							)}
							{/* A poll that failed keeps the dots on screen — they are still the best answer
							    anyone has — but says so, because a stale verdict presented as fresh is the
							    failure #291 is about. */}
							{activity.stale && (
								<span className="text-2xs text-muted-soft">
									Status may be out of date.{" "}
									<button type="button" onClick={activity.refresh} className="text-accent underline">Retry</button>
								</span>
							)}
						</div>
					)}
					{loading ? (
						<p className="text-center py-8 text-muted">Loading instances...</p>
					) : instances.length === 0 ? (
						<p className="text-center py-8 text-muted-soft">No instances yet. <button type="button" onClick={() => navigate("/browse")} className="text-accent underline">Subscribe to an agent</button> to create your first one.</p>
					) : visibleInstances.length === 0 ? (
						/* A filter matching nothing is NOT an empty account, and must not be told as
						   one. Reusing the branch above would state something false and then act on
						   it, sending a user who already has instances off to the Library to make
						   another. The way out of THIS state is to clear the filter, so that is what
						   it offers — and it names the count being hidden, because the number is the
						   part that says the rows are still there. */
						<p className="text-center py-8 text-muted-soft" data-testid="instances-no-match">
							{instanceQuery.trim()
								? `No instances match "${instanceQuery.trim()}"`
								: instanceHealth
									? `Nothing is ${HEALTH_LABEL[instanceHealth].toLowerCase()} right now`
									: "No instances match"}
							{instanceAgent ? " for that agent" : ""}.{" "}
							<button type="button" onClick={clearInstanceFilters} className="text-accent underline">Clear the filter</button> to see all {instances.length}.
						</p>
					) : (
						<div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-3">
							{visibleInstances.map((inst) => {
								// Identity is computed, not styled inline: the tint hashes the INSTANCE id so
								// three Repo Coders (one per repo) never share a colour. See lib/identity.ts.
								const id = identityFor(inst);
								const badges = capabilityBadges(inst);
								const act = activityFor(activity.byInstance, inst.id);
								const outcome = outcomeLine(act, activity.asOf || Date.now());
								return (
									<button key={inst.id} type="button" onClick={() => navigate(`/instances/${inst.id}`)}
										className="text-left bg-panel border border-line rounded-xl p-3 sm:p-4 cursor-pointer transition-all hover:border-accent hover:-translate-y-px hover:shadow-lg">
										<div className="flex items-start gap-3 mb-2">
											{/* The mark does the recognising — reading the title should be the fallback,
											    not the only way to tell two agents apart. */}
											<div
												className="w-10 h-10 rounded-xl flex items-center justify-center text-xl shrink-0 shadow-sm"
												style={{ background: id.bg }}
												aria-hidden="true"
											>
												<span>{id.emoji}</span>
											</div>
											<div className="min-w-0 flex-1">
												<h3 className="text-base font-bold leading-tight truncate">{inst.name}</h3>
												{/* "FAS platform" over "Repo Coder" — which one, then what it is. */}
												{id.subtitle && <p className="text-xs text-muted truncate">{id.subtitle}</p>}
											</div>
										</div>
										<p className="text-sm text-muted mb-2 leading-relaxed line-clamp-2">{inst.description || "No description"}</p>
										{/* What it is DOING (#815). This replaced a hardcoded "active" pill that every
										    card wore and which therefore said nothing — and it is deliberately the
										    server's verdict, not "has an open run": a park has nothing ticking by
										    design and a wedged run has nothing ticking because it is dead. Only
										    `working` pulses; only `stalled` is danger. */}
										<div className="flex items-center gap-1.5 mb-1.5 text-xs" data-testid="instance-status">
											<span className={`w-2 h-2 rounded-full shrink-0 ${HEALTH_DOT[act.health]}`} aria-hidden="true" />
											<span className={`font-semibold ${HEALTH_TEXT[act.health]}`}>{HEALTH_LABEL[act.health]}</span>
											{act.queueDepth > 0 && (
												<span
													className="px-1.5 py-0.5 rounded font-medium bg-line text-muted"
													title={`${act.queueDepth} objective${act.queueDepth === 1 ? "" : "s"} waiting behind this instance`}
												>
													+{act.queueDepth} queued
												</span>
											)}
										</div>
										{outcome && <p className="text-2xs text-muted-soft mb-1.5 truncate">{outcome}</p>}
										<div className="flex gap-1.5 text-xs flex-wrap">
											{/* Real capabilities instead of a constant "subscribed" that every card showed
											    and which therefore distinguished nothing. The status above is the live
											    half; these are what the instance CAN do. */}
											{badges.map((b) => (
												<span key={b} className="px-1.5 py-0.5 rounded font-medium bg-accent-soft text-accent">{b}</span>
											))}
										</div>
									</button>
								);
							})}
						</div>
					)}
				</div>
			)}

			{/* Stats dashboard */}
			{tab === "dashboard" && (
				<div>
					<h2 className="text-lg font-semibold mb-4">Platform Dashboard</h2>
					{statsErr ? (
						<LoadFailed what="your stats" detail={statsErr} onRetry={loadDashboard} testId="dashboard-load-failed" />
					) : !stats ? (
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
						<h2 className="text-lg font-semibold">Platform Tools</h2>
						<p className="text-sm text-muted mt-1 leading-relaxed">
							Tools are capability-gated. Coder, Repo Chat, generic agents, connectors, triggers, and MCP clients each see the tools they can actually use.
						</p>
					</div>
					<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
						{platformToolGroups.map((group) => (
							<section key={group.title} className="bg-panel border border-line rounded-lg p-3 sm:p-4">
								<div className="flex items-start justify-between gap-3 mb-3">
									<div className="min-w-0">
										<h3 className="text-base font-bold">{group.title}</h3>
										<p className="text-xs text-muted mt-1 leading-relaxed">{group.description}</p>
									</div>
									<span className="shrink-0 text-2xs px-2 py-1 rounded-md bg-line text-muted font-semibold whitespace-nowrap">{group.scope}</span>
								</div>
								<div className="divide-y divide-line/80">
									{group.tools.map((tool) => (
										<div key={tool.name} className="py-2 first:pt-0 last:pb-0">
											<div className="flex items-start justify-between gap-2">
												<code className="text-xs text-ink bg-line/60 px-1.5 py-0.5 rounded break-all">{tool.name}</code>
												{tool.status && (
													<span className="text-2xs text-muted-soft border border-line rounded px-1.5 py-0.5 whitespace-nowrap">{tool.status}</span>
												)}
											</div>
											<p className="text-xs text-muted mt-1 leading-relaxed">{tool.description}</p>
										</div>
									))}
								</div>
							</section>
						))}
					</div>

					{/* What your MCP clients are told — the two global runtime constants (#753) */}
					<div className="mt-6 border border-line rounded-lg overflow-hidden">
						<button
							type="button"
							onClick={() => setSurfaceOpen((o) => !o)}
							className="w-full flex items-center justify-between px-4 py-3 bg-panel hover:bg-line/30 transition-colors text-left"
						>
							<div>
								<span className="text-sm font-semibold">What your MCP clients are told</span>
								{surfaceDoc && (
									<span className="ml-2 text-2xs text-muted">
										v{surfaceDoc.version} · {surfaceDoc.toolCount} tools
									</span>
								)}
							</div>
							<span className="text-muted text-xs">{surfaceOpen ? "▲" : "▼"}</span>
						</button>
						{surfaceOpen && (
							<div className="px-4 pb-4 pt-2 bg-panel border-t border-line space-y-4">
								<p className="text-xs text-muted leading-relaxed">
									These two strings are delivered to every MCP client that connects.{" "}
									<code className="text-2xs bg-line/60 px-1 rounded">instructions</code> is sent
									once at <code className="text-2xs bg-line/60 px-1 rounded">initialize</code>;{" "}
									<code className="text-2xs bg-line/60 px-1 rounded">guide</code> is what
									the <code className="text-2xs bg-line/60 px-1 rounded">platform_guide</code> tool
									returns. Both are read-only — they come directly from the deployed MCP server.
								</p>
								{surfaceErr ? (
									<LoadFailed what="the MCP surface" detail={surfaceErr} onRetry={loadSurface} testId="surface-load-failed" />
								) : !surfaceDoc ? (
									<p className="text-xs text-muted py-2">Loading...</p>
								) : (
									<>
										<SurfaceBlock
											label="Server instructions"
											field="instructions"
											text={surfaceDoc.instructions}
											copied={copied}
											onCopy={copyText}
										/>
										<SurfaceBlock
											label="Platform guide (platform_guide tool return)"
											field="guide"
											text={surfaceDoc.guide}
											copied={copied}
											onCopy={copyText}
										/>
									</>
								)}
							</div>
						)}
					</div>
				</div>
			)}
		</Page>
	);
}

function tagClass(value: string): string {
	switch (value) {
		case "draft": return "bg-warning-soft text-warning";
		case "unlisted": return "bg-info-soft text-info";
		case "published": case "active": return "bg-success-soft text-success";
		case "error": return "bg-danger-soft text-danger";
		default: return "bg-muted/15 text-muted";
	}
}

function SurfaceBlock({
	label,
	field,
	text,
	copied,
	onCopy,
}: {
	label: string;
	field: "instructions" | "guide";
	text: string;
	copied: "instructions" | "guide" | null;
	onCopy: (field: "instructions" | "guide", text: string) => void;
}) {
	return (
		<div>
			<div className="flex items-center justify-between mb-1">
				<span className="text-xs font-medium text-muted">{label}</span>
				<button
					type="button"
					onClick={() => onCopy(field, text)}
					className="text-2xs text-accent hover:text-accent/80 transition-colors"
				>
					{copied === field ? "Copied" : "Copy"}
				</button>
			</div>
			<pre className="text-xs bg-line/30 rounded p-3 overflow-x-auto whitespace-pre-wrap break-words leading-relaxed max-h-48 overflow-y-auto">
				{text}
			</pre>
		</div>
	);
}
