import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Card from "../components/Card";
import Button from "../components/Button";
import { answerWebsiteRequest, getWebsiteRequest, websiteAnswerMessage, websiteSubjectPath, type WebsiteRequestResponse } from "../lib/websiteAccess";

export function WebsiteRequestCard({ data, busy, message, error, onAnswer }: {
	data: WebsiteRequestResponse;
	busy: boolean;
	message: string;
	error: string;
	onAnswer: (decision: "approve" | "deny") => void;
}) {
	const request = data.request;
	const subjectPath = websiteSubjectPath(request.subjectLink);
	return <Card className="w-full min-w-0">
		<h1 className="text-xl font-bold">Website access</h1>
		<p className="mt-3 break-words"><strong>{request.instanceName || "Your agent"}</strong> wants to visit:</p>
		<p className="my-4 rounded border border-line bg-panel p-3 font-mono text-lg break-all" data-testid="requested-website">{request.hostname}</p>
		<p className="text-sm text-muted">Your choice applies to this agent and this exact hostname. Other websites follow the agent's website access settings.</p>
		<div className="mt-4 text-sm space-y-2">
			<p>Requested {new Date(request.createdAt).toLocaleString()}</p>
			{subjectPath ? <Link className="text-accent underline" to={subjectPath}>View originating run</Link> : <p className="break-all">Originating run: {request.subjectId}</p>}
		</div>
		{request.status === "pending" ? <>
			{data.current === false && <p className="mt-4 text-sm">The originating run is no longer waiting on this request. Your choice will be remembered for future visits and will not restart the run.</p>}
			<p className="text-sm mt-4">Allow or deny is remembered until you remove the decision in this agent's browser settings.</p>
			<div className="flex flex-col sm:flex-row gap-3 mt-4">
				<Button variant="primary" disabled={busy} onClick={() => onAnswer("approve")}>{busy ? "Saving…" : "Allow and remember"}</Button>
				<Button disabled={busy} onClick={() => onAnswer("deny")}>Deny</Button>
			</div>
		</> : <p role="status" className="mt-4 font-semibold">{request.status === "approved" ? "This request was allowed." : "This request was denied."}</p>}
		{message && <p role="status" className="text-sm mt-4 break-words">{message}</p>}
		{error && <p role="alert" className="text-sm text-danger mt-4 break-words">{error}</p>}
	</Card>;
}

/** Reading an owner question is inert. Only an explicit button press records a decision. */
export default function WebsiteRequest() {
	const { id, requestId } = useParams<{ id: string; requestId: string }>();
	const [data, setData] = useState<WebsiteRequestResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const revision = useRef(0);
	const load = useCallback(async () => {
		if (!id || !requestId) return;
		const turn = ++revision.current;
		try {
			const response = await getWebsiteRequest(id, requestId);
			if (turn !== revision.current) return;
			if (response.request.id !== requestId || response.request.instanceId !== id) throw new Error("This response belongs to another website request. Reload the page.");
			setData(response); setError("");
		}
		catch (cause) { if (turn === revision.current) setError(cause instanceof Error ? cause.message : "Could not load the website request."); }
		finally { if (turn === revision.current) setLoading(false); }
	}, [id, requestId]);
	useEffect(() => { setData(null); setLoading(true); setBusy(false); setError(""); setMessage(""); void load(); return () => { revision.current++; }; }, [load]);
	useEffect(() => {
		if (data?.request.status !== "pending" || busy) return;
		const timer = setInterval(() => void load(), 20_000);
		return () => clearInterval(timer);
	}, [data?.request.status, busy, load]);
	const answer = async (decision: "approve" | "deny") => {
		if (!id || !requestId || busy || data?.request.status !== "pending" || data.request.id !== requestId || data.request.instanceId !== id) return;
		const turn = ++revision.current;
		setBusy(true); setError(""); setMessage("");
		try { const response = await answerWebsiteRequest(id, requestId, decision); if (turn === revision.current) { setData(response); setMessage(websiteAnswerMessage(response)); } }
		catch (cause) { if (turn === revision.current) setError(cause instanceof Error ? cause.message : "Could not save your decision."); }
		finally { if (turn === revision.current) setBusy(false); }
	};
	return <div className="mx-auto w-full max-w-2xl p-4 sm:p-6 min-w-0">
		<Link to={`/instances/${encodeURIComponent(id ?? "")}`} className="inline-block mb-4 text-sm text-accent underline">Back to agent</Link>
		{loading ? <p role="status">Loading website request…</p> : data ? <WebsiteRequestCard data={data} busy={busy} message={message} error={error} onAnswer={(decision) => void answer(decision)} /> : <div role="alert"><p className="break-words">{error || "Website request not found."}</p><Button className="mt-3" onClick={() => { setLoading(true); void load(); }}>Try again</Button></div>}
	</div>;
}
