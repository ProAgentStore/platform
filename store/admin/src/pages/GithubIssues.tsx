import { useEffect, useMemo, useState } from "react";
import { api, fmtInt } from "../lib/api";
import { Empty, ErrorBox, Loading, Panel, Stat } from "../lib/ui";

type IssueState = "open" | "closed";
type Severity = "critical" | "high" | "medium" | "low" | "none";

interface IssueRow {
	number: number;
	title: string;
	state: IssueState;
	labels: string[];
	severity: Severity;
	createdAt: string;
	closedAt: string | null;
	updatedAt: string;
	url: string;
	comments: number;
}

interface IssueReport {
	repo: string;
	generatedAt: string;
	complete: boolean;
	fetched: number;
	totals: { all: number; open: number; closed: number };
	bySeverity: Record<Severity, { total: number; open: number; closed: number }>;
	labels: Array<{ name: string; total: number; open: number; closed: number }>;
	history: HistoryPoint[];
	issues: IssueRow[];
}

interface HistoryPoint {
	date: string;
	opened: number;
	closed: number;
	openTotal: number;
	totalFiled: number;
	totalClosed: number;
}

const RANGES = [
	{ value: "30", label: "30d" },
	{ value: "90", label: "90d" },
	{ value: "365", label: "1y" },
	{ value: "all", label: "All" },
];
const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "none"];

export default function GithubIssues() {
	const [repoInput, setRepoInput] = useState("ProAgentStore/platform");
	const [repo, setRepo] = useState("ProAgentStore/platform");
	const [range, setRange] = useState("365");
	const [state, setState] = useState<"all" | IssueState>("all");
	const [severity, setSeverity] = useState<"all" | Severity>("all");
	const [label, setLabel] = useState("");
	const [search, setSearch] = useState("");
	const [data, setData] = useState<IssueReport | null>(null);
	const [err, setErr] = useState("");

	const since = useMemo(() => {
		if (range === "all") return "";
		const days = Number(range) || 365;
		return new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
	}, [range]);

	useEffect(() => {
		setData(null);
		setErr("");
		const qs = new URLSearchParams({ repo });
		if (since) qs.set("since", since);
		api<IssueReport>(`/v1/admin/github/issues?${qs.toString()}`).then(setData).catch((e) => setErr(e.message));
	}, [repo, since]);

	const filtered = useMemo(() => {
		const needle = search.trim().toLowerCase();
		return (data?.issues ?? []).filter((issue) => {
			if (state !== "all" && issue.state !== state) return false;
			if (severity !== "all" && issue.severity !== severity) return false;
			if (label && !issue.labels.includes(label)) return false;
			if (needle && !`${issue.number} ${issue.title} ${issue.labels.join(" ")}`.toLowerCase().includes(needle)) return false;
			return true;
		});
	}, [data, state, severity, label, search]);

	const history = useMemo(() => filteredHistory(filtered, since), [filtered, since]);
	const labelOptions = data?.labels ?? [];
	const filteredOpen = filtered.filter((issue) => issue.state === "open").length;
	const filteredClosed = filtered.length - filteredOpen;

	const applyRepo = () => setRepo(repoInput.trim() || "ProAgentStore/platform");

	return (
		<div>
			<div className="flex flex-wrap items-center justify-between gap-3 mb-4">
				<h1 className="font-display text-xl font-bold">GitHub issues</h1>
				<div className="flex flex-wrap items-center gap-2">
					<input
						aria-label="GitHub repository"
						value={repoInput}
						onChange={(e) => setRepoInput(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && applyRepo()}
						className="!w-auto min-w-[15rem] text-sm font-mono"
					/>
					<button type="button" onClick={applyRepo} className="text-sm px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-white font-semibold">Load</button>
					<select aria-label="Time range" value={range} onChange={(e) => setRange(e.target.value)} className="!w-auto text-sm">
						{RANGES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
					</select>
				</div>
			</div>

			{err ? <ErrorBox message={err} /> : !data ? <Loading /> : (
				<>
					<div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
						<Stat label="Fetched" value={fmtInt(data.fetched)} />
						<Stat label="Open" value={fmtInt(data.totals.open)} accent={data.totals.open > 0} />
						<Stat label="Closed" value={fmtInt(data.totals.closed)} />
						<Stat label="Filtered open" value={fmtInt(filteredOpen)} accent={filteredOpen > 0} />
						<Stat label="Filtered closed" value={fmtInt(filteredClosed)} />
					</div>

					<div className="grid xl:grid-cols-[minmax(0,1fr)_20rem] gap-4">
						<Panel
							title={`${data.repo} history`}
							right={!data.complete ? <span className="text-xs text-warning">first {fmtInt(data.fetched)} issues</span> : <span className="text-xs text-muted-soft">{data.generatedAt.slice(0, 16)}</span>}
						>
							<HistoryChart points={history} />
						</Panel>
						<Panel title="Severity">
							<div className="space-y-2">
								{SEVERITIES.map((s) => {
									const row = severityCounts(filtered, s);
									return (
										<button key={s} type="button" onClick={() => setSeverity(severity === s ? "all" : s)} className={`w-full text-left border rounded-lg p-2 ${severity === s ? "border-accent bg-accent-soft" : "border-line hover:bg-panel-hover"}`}>
											<div className="flex items-center justify-between text-sm">
												<span className={severityClass(s)}>{s}</span>
												<span className="font-semibold">{fmtInt(row.total)}</span>
											</div>
											<div className="text-xs text-muted">{fmtInt(row.open)} open · {fmtInt(row.closed)} closed</div>
										</button>
									);
								})}
							</div>
						</Panel>
					</div>

					<Panel title={`Issues (${fmtInt(filtered.length)})`}>
						<div className="flex flex-wrap items-center gap-2 mb-3">
							<select aria-label="Filter by state" value={state} onChange={(e) => setState(e.target.value as "all" | IssueState)} className="!w-auto text-sm">
								<option value="all">All states</option>
								<option value="open">Open</option>
								<option value="closed">Closed</option>
							</select>
							<select aria-label="Filter by severity" value={severity} onChange={(e) => setSeverity(e.target.value as "all" | Severity)} className="!w-auto text-sm">
								<option value="all">All severities</option>
								{SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
							</select>
							<select aria-label="Filter by label" value={label} onChange={(e) => setLabel(e.target.value)} className="!w-auto text-sm max-w-[16rem]">
								<option value="">All labels</option>
								{labelOptions.map((l) => <option key={l.name} value={l.name}>{l.name} ({l.total})</option>)}
							</select>
							<input aria-label="Search GitHub issues" placeholder="Search issues…" value={search} onChange={(e) => setSearch(e.target.value)} className="!w-auto flex-1 min-w-[180px] text-sm" />
						</div>
						{filtered.length === 0 ? <Empty label="No issues match these filters." /> : <IssueTable issues={filtered.slice(0, 200)} />}
					</Panel>
				</>
			)}
		</div>
	);
}

function IssueTable({ issues }: { issues: IssueRow[] }) {
	return (
		<div className="overflow-x-auto">
			<table className="w-full text-sm">
				<thead>
					<tr className="text-muted text-xs uppercase text-left border-b border-line">
						<th className="py-1.5">Issue</th>
						<th>State</th>
						<th>Severity</th>
						<th>Labels</th>
						<th>Updated</th>
					</tr>
				</thead>
				<tbody>
					{issues.map((issue) => (
						<tr key={issue.number} className="border-b border-line/50 hover:bg-panel-hover align-top">
							<td className="py-1.5 min-w-[18rem]">
								<a href={issue.url} target="_blank" rel="noopener" className="text-accent hover:underline">#{issue.number}</a>{" "}
								<span>{issue.title}</span>
								<div className="text-xs text-muted-soft">filed {issue.createdAt.slice(0, 10)}{issue.closedAt ? ` · closed ${issue.closedAt.slice(0, 10)}` : ""}</div>
							</td>
							<td><span className={issue.state === "open" ? "text-warning" : "text-success"}>{issue.state}</span></td>
							<td><span className={severityClass(issue.severity)}>{issue.severity}</span></td>
							<td className="max-w-[22rem]">
								<div className="flex flex-wrap gap-1">
									{issue.labels.length ? issue.labels.map((l) => <span key={l} className="text-xs border border-line rounded px-1.5 py-0.5 text-muted">{l}</span>) : <span className="text-muted-soft">none</span>}
								</div>
							</td>
							<td className="text-muted whitespace-nowrap">{issue.updatedAt.slice(0, 10)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function HistoryChart({ points }: { points: HistoryPoint[] }) {
	if (!points.length) return <Empty label="No history in this window." />;
	const width = 720;
	const height = 220;
	const pad = 26;
	const max = Math.max(1, ...points.flatMap((p) => [p.opened, p.closed, p.openTotal]));
	const x = (i: number) => pad + (i / Math.max(1, points.length - 1)) * (width - pad * 2);
	const y = (v: number) => height - pad - (v / max) * (height - pad * 2);
	const line = (key: keyof Pick<HistoryPoint, "opened" | "closed" | "openTotal">) => points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
	const last = points[points.length - 1];
	return (
		<div>
			<div className="flex flex-wrap items-center gap-3 text-xs text-muted mb-2">
				<span><span className="text-accent">■</span> filed</span>
				<span><span className="text-success">■</span> closed</span>
				<span><span className="text-warning">■</span> open total</span>
				<span className="ml-auto text-muted-soft">now {fmtInt(last.openTotal)} open · {fmtInt(last.totalFiled)} filed · {fmtInt(last.totalClosed)} closed</span>
			</div>
			<svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="GitHub issue history" className="w-full h-56 border border-line rounded-lg bg-paper">
				<line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="var(--color-line)" />
				<line x1={pad} y1={pad} x2={pad} y2={height - pad} stroke="var(--color-line)" />
				<text x={width - pad} y={16} textAnchor="end" className="fill-muted-soft text-2xs">{fmtInt(max)}</text>
				<path d={line("openTotal")} fill="none" stroke="var(--color-warning)" strokeWidth="2.5" />
				<path d={line("opened")} fill="none" stroke="var(--color-accent)" strokeWidth="2" />
				<path d={line("closed")} fill="none" stroke="var(--color-success)" strokeWidth="2" />
				{points.map((p, i) => (i % Math.ceil(points.length / 8) === 0 || i === points.length - 1) ? (
					<text key={p.date} x={x(i)} y={height - 8} textAnchor="middle" className="fill-muted-soft text-2xs">{p.date.slice(5)}</text>
				) : null)}
			</svg>
		</div>
	);
}

function filteredHistory(issues: IssueRow[], since: string): HistoryPoint[] {
	if (!issues.length) return [];
	const firstDay = since || issues.map((issue) => issue.createdAt.slice(0, 10)).sort()[0];
	const lastDay = new Date().toISOString().slice(0, 10);
	const opened = new Map<string, number>();
	const closed = new Map<string, number>();
	for (const issue of issues) {
		add(opened, issue.createdAt.slice(0, 10));
		if (issue.closedAt) add(closed, issue.closedAt.slice(0, 10));
	}
	let totalFiled = issues.filter((issue) => issue.createdAt.slice(0, 10) < firstDay).length;
	let totalClosed = issues.filter((issue) => issue.closedAt && issue.closedAt.slice(0, 10) < firstDay).length;
	return daysBetween(firstDay, lastDay).map((date) => {
		const filedToday = opened.get(date) ?? 0;
		const closedToday = closed.get(date) ?? 0;
		totalFiled += filedToday;
		totalClosed += closedToday;
		return { date, opened: filedToday, closed: closedToday, totalFiled, totalClosed, openTotal: totalFiled - totalClosed };
	});
}

function severityCounts(issues: IssueRow[], severity: Severity) {
	const rows = issues.filter((issue) => issue.severity === severity);
	const closed = rows.filter((issue) => issue.state === "closed").length;
	return { total: rows.length, open: rows.length - closed, closed };
}

function severityClass(severity: Severity): string {
	if (severity === "critical") return "text-danger";
	if (severity === "high") return "text-warning";
	if (severity === "medium") return "text-info";
	if (severity === "low") return "text-success";
	return "text-muted";
}

function add(map: Map<string, number>, key: string): void {
	map.set(key, (map.get(key) ?? 0) + 1);
}

function daysBetween(start: string, end: string): string[] {
	const out: string[] = [];
	const startDate = new Date(`${start}T00:00:00Z`);
	const endDate = new Date(`${end}T00:00:00Z`);
	for (let t = startDate.getTime(); t <= endDate.getTime(); t += 86_400_000) {
		out.push(new Date(t).toISOString().slice(0, 10));
	}
	return out;
}
