import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Empty, ErrorBox, Loading, Panel } from "../lib/ui";

interface McpAuditEvent {
	time?: string;
	subject?: string;
	tool?: string;
	action?: string;
	reason?: string;
	requiredScope?: string;
	scopes?: string[] | string | null;
	result?: unknown;
}

/** "denied" is the block signal (safety.ts); everything else is an allowed call. */
function isDenied(a?: string): boolean {
	return a === "denied";
}

function scopeText(e: McpAuditEvent): string {
	if (e.requiredScope) return e.requiredScope;
	if (Array.isArray(e.scopes)) return e.scopes.join(", ");
	if (typeof e.scopes === "string") return e.scopes;
	return "—";
}

function resultText(e: McpAuditEvent): string {
	if (isDenied(e.action)) return e.reason ? `denied: ${e.reason}` : "denied";
	return e.action || "—";
}

export default function McpAudit() {
	const [events, setEvents] = useState<McpAuditEvent[] | null>(null);
	const [err, setErr] = useState("");
	const [tool, setTool] = useState("");
	const [user, setUser] = useState("");

	function load() {
		setEvents(null);
		setErr("");
		const qs = new URLSearchParams({ limit: "200" });
		if (tool.trim()) qs.set("tool", tool.trim());
		if (user.trim()) qs.set("user", user.trim());
		api<{ events: McpAuditEvent[] }>(`/v1/admin/mcp-audit?${qs.toString()}`)
			.then((r) => setEvents(r.events))
			.catch((e) => setErr(e.message));
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: load once on mount; `load` is recreated each render so listing it would refetch on every render
	useEffect(() => {
		load();
	}, []);

	return (
		<div>
			<h1 className="font-display text-xl font-bold mb-1">MCP audit log</h1>
			<p className="text-sm text-muted mb-4">
				Every MCP tool call across all users — writes, runtime, dry-runs, and denials. Newest first.
			</p>
			<div className="flex flex-wrap gap-2 mb-4">
				<input
					value={tool}
					onChange={(e) => setTool(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && load()}
					aria-label="Filter MCP calls by tool"
					placeholder="Filter by tool"
					className="border border-line rounded px-2 py-1 text-sm"
				/>
				<input
					value={user}
					onChange={(e) => setUser(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && load()}
					aria-label="Filter MCP calls by user id"
					placeholder="Filter by user id"
					className="border border-line rounded px-2 py-1 text-sm"
				/>
				<button
					type="button"
					onClick={load}
					className="bg-accent-soft text-accent border border-accent/30 rounded px-3 py-1 text-sm font-medium"
				>
					Apply
				</button>
			</div>
			{err ? (
				<ErrorBox message={err} />
			) : !events ? (
				<Loading />
			) : (
				<Panel>
					{!events.length ? (
						<Empty label="No MCP tool calls yet." />
					) : (
						<div className="overflow-x-auto">
							<table className="w-full text-sm">
								<thead>
									<tr className="text-muted text-xs uppercase text-left border-b border-line">
										<th className="py-1.5">When</th>
										<th>User</th>
										<th>Tool</th>
										<th>Scope</th>
										<th>Result</th>
									</tr>
								</thead>
								<tbody>
									{events.map((e, i) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: append-only audit feed with no unique id; distinct events can share the same timestamp/tool/subject, so the row index is the only stable disambiguator
										<tr key={`${e.time ?? ""}-${e.tool ?? ""}-${e.subject ?? ""}-${i}`} className="border-b border-line/50">
											<td className="py-1.5 text-muted whitespace-nowrap">{e.time?.slice(0, 16) ?? "—"}</td>
											<td className="truncate max-w-[160px]">{e.subject ?? "—"}</td>
											<td className="text-accent">{e.tool ?? "—"}</td>
											<td className="text-muted whitespace-nowrap">{scopeText(e)}</td>
											<td className={isDenied(e.action) ? "text-red-400" : "text-muted"}>{resultText(e)}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</Panel>
			)}
		</div>
	);
}
