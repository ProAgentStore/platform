import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api";
import { Empty, ErrorBox, Loading, Panel } from "../lib/ui";

interface Session {
	id: string;
	instanceId: string;
	repoId: string;
	userId: string;
	runnerNode: string | null;
	engine: string;
	status: string;
	issueNumber: number | null;
	issueTitle: string | null;
	launchCommand: string | null;
	startedAt: string;
	updatedAt: string;
	repoName: string | null;
	ownerLogin: string | null;
}
interface Entry {
	seq: number;
	type: string;
	content: string;
	createdAt: string;
}
interface Resp {
	session: Session;
	timeline: Entry[];
}

const field = (label: string, value: React.ReactNode) => (
	<div>
		<div className="text-xs text-muted-soft">{label}</div>
		<div className="text-sm">{value ?? "—"}</div>
	</div>
);

export default function SessionDetail() {
	const { sid } = useParams();
	const [data, setData] = useState<Resp | null>(null);
	const [err, setErr] = useState("");

	useEffect(() => {
		if (!sid) return;
		setErr("");
		setData(null);
		api<Resp>(`/v1/admin/coding-sessions/${encodeURIComponent(sid)}`).then(setData).catch((e) => setErr(e.message));
	}, [sid]);

	if (err) return <ErrorBox message={err} />;
	if (!data) return <Loading />;

	const s = data.session;

	return (
		<div>
			<Panel title="Coding session">
				<div className="grid grid-cols-2 md:grid-cols-3 gap-3">
					{field("Engine", <span className="text-accent">{s.engine}</span>)}
					{field("Status", s.status)}
					{field("Repo", s.repoName || s.repoId)}
					{field("Owner", s.ownerLogin || s.userId)}
					{field("Machine", <span className="font-mono">{s.runnerNode || "—"}</span>)}
					{field("Issue", s.issueTitle ? `#${s.issueNumber ?? "?"} ${s.issueTitle}` : s.issueNumber ? `#${s.issueNumber}` : "—")}
					{field("Started", s.startedAt?.slice(0, 16))}
					{field("Updated", s.updatedAt?.slice(0, 16))}
					{field("Session id", <span className="font-mono text-xs">{s.id}</span>)}
					{field("Instance id", <span className="font-mono text-xs">{s.instanceId}</span>)}
				</div>
				{s.launchCommand && (
					<div className="mt-3">
						<div className="text-xs text-muted-soft">Launch command</div>
						<pre className="text-xs bg-paper border border-line rounded p-2 overflow-x-auto whitespace-pre-wrap font-mono text-muted mt-1">{s.launchCommand}</pre>
					</div>
				)}
			</Panel>

			<Panel title={`Timeline (${data.timeline.length})`}>
				{!data.timeline.length ? (
					<Empty label="No timeline entries recorded for this session." />
				) : (
					data.timeline.map((e) => (
						<div key={e.seq} className="mt-2 border-t border-line/50 pt-2 first:border-t-0 first:pt-0 first:mt-0">
							<div className="flex gap-2 text-xs text-muted mb-1">
								<span className="text-muted-soft">#{e.seq}</span>
								<span className="text-accent">{e.type}</span>
								<span className="ml-auto">{e.createdAt?.slice(0, 16)}</span>
							</div>
							<pre className="text-xs bg-paper border border-line rounded p-2 overflow-x-auto whitespace-pre-wrap max-h-56 overflow-y-auto font-mono text-muted">{e.content}</pre>
						</div>
					))
				)}
			</Panel>
		</div>
	);
}
