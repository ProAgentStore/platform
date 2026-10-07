import { useCallback, useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import { AlertCircle, Loader2, CheckCircle, ArrowLeft } from "lucide-react";
import Button from "../components/Button";
import type { SecureInputView } from "../lib/types";
import { isMachineDeposit, secureInputStatusLine } from "../lib/secureInput";

/** A stored `datetime('now')` (UTC, no zone) or an ISO time, in the reader's own clock. */
function stamp(at: string): string {
	const t = Date.parse(at.includes("T") ? at : `${at.replace(" ", "T")}Z`);
	return Number.isNaN(t) ? at : new Date(t).toLocaleString();
}

export default function SecureInputDetail() {
	const { id: instanceId, requestId } = useParams<{ id: string; requestId: string }>();
	const navigate = useNavigate();
	const [request, setRequest] = useState<SecureInputView | null>(null);
	const [value, setValue] = useState("");
	const [loading, setLoading] = useState(true);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState("");
	/** Why the request could not be read — shown as itself, not as "not found" (#929 finding 14). */
	const [loadError, setLoadError] = useState("");

	const load = useCallback(async () => {
		if (!instanceId || !requestId) return;
		try {
			const res = await api<SecureInputView>(`/v1/instances/${instanceId}/secure-inputs/${requestId}`);
			setRequest(res);
			setLoadError("");
		} catch (e) {
			setLoadError(e instanceof Error ? e.message : "Failed to load request");
		} finally {
			setLoading(false);
		}
	}, [instanceId, requestId]);

	useEffect(() => {
		void load();
	}, [load]);

	// Re-read while the request can still change under this page (#929 finding 14): an entered value
	// is consumed by the agent, a deposit is retrieved on another machine — and the page used to keep
	// saying "ready" until it was reloaded. The list on the chat tab already polls at this rate.
	const open = request?.status === "pending" || request?.status === "ready";
	useEffect(() => {
		if (!open) return;
		const t = setInterval(() => void load(), 20_000);
		return () => clearInterval(t);
	}, [open, load]);

	const handleSubmit = async () => {
		if (!instanceId || !requestId || !value) return;
		setSubmitting(true);
		setError("");
		try {
			await api(`/v1/instances/${instanceId}/secure-inputs/${requestId}/submit`, {
				method: "POST",
				body: JSON.stringify({ value }),
			});
			setRequest((prev) => (prev ? { ...prev, status: "ready" } : null));
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to submit");
		} finally {
			setSubmitting(false);
		}
	};

	if (loading) {
		return (
			<div className="flex items-center justify-center min-h-[80dvh]">
				<div className="text-muted text-sm">Loading…</div>
			</div>
		);
	}

	if (!request) {
		return (
			<div className="flex flex-col items-center justify-center min-h-[80dvh] gap-4">
				<p className="text-muted">{loadError || "Request not found"}</p>
				<Button onClick={() => navigate(`/instances/${instanceId}`)}>Back to instance</Button>
			</div>
		);
	}

	return (
		<div className="flex flex-col min-h-[80dvh]">
			<div className="border-b border-line p-4 flex items-center justify-between">
				<div className="flex items-center gap-3">
					<button type="button" onClick={() => navigate(`/instances/${instanceId}`)} className="p-1 hover:bg-panel rounded">
						<ArrowLeft size={20} />
					</button>
					<div>
						<h1 className="text-lg font-semibold">{request.label}</h1>
						<p className="text-sm text-muted">{secureInputStatusLine(request)}</p>
					</div>
				</div>
			</div>

			<div className="flex-1 p-6 max-w-2xl">
				{request.purpose && (
					<div className="mb-6 p-4 border border-line rounded-lg bg-panel">
						<p className="text-sm text-muted">{request.purpose}</p>
					</div>
				)}

				{isMachineDeposit(request) && request.status !== "expired" ? (
					// A machine deposit (#918): there is no form — the value went from one machine to the
					// encrypted store, and (when consumed) on to another, without passing through here.
					<div className="flex flex-col items-center justify-center gap-4 py-12">
						<CheckCircle size={48} className={request.status === "consumed" ? "text-success" : "text-muted"} />
						<div className="text-center">
							<p className="font-semibold mb-1">{secureInputStatusLine(request)}</p>
							<p className="text-sm text-muted">The value is encrypted and is never shown here, in chat, or in any tool result.</p>
						</div>
					</div>
				) : request.status === "ready" ? (
					<div className="flex flex-col items-center justify-center gap-4 py-12">
						<CheckCircle size={48} className="text-success" />
						<div className="text-center">
							<p className="font-semibold mb-1">Submitted successfully</p>
							<p className="text-sm text-muted">Your value has been received and is ready for injection.</p>
						</div>
					</div>
				) : request.status === "consumed" ? (
					<div className="flex flex-col items-center justify-center gap-4 py-12">
						<CheckCircle size={48} className="text-success" />
						<div className="text-center">
							<p className="font-semibold mb-1">Already consumed</p>
							<p className="text-sm text-muted">This secret has been injected and is no longer available.</p>
						</div>
					</div>
				) : request.status === "expired" ? (
					<div className="flex flex-col items-center justify-center gap-4 py-12">
						<AlertCircle size={48} className="text-warning" />
						<div className="text-center">
							<p className="font-semibold mb-1">Request expired</p>
							<p className="text-sm text-muted">This request passed its expiry unused, and the value was deleted.</p>
						</div>
					</div>
				) : (
					<form
						onSubmit={(e) => {
							e.preventDefault();
							void handleSubmit();
						}}
						className="space-y-4"
					>
						<div className="flex flex-col gap-2">
							<label htmlFor="value" className="font-semibold text-sm">
								Enter value <span className="text-warning">*</span>
							</label>
							<input
								id="value"
								type="password"
								value={value}
								onChange={(e) => setValue(e.target.value)}
								autoComplete="off"
								placeholder={`Enter ${request.label.toLowerCase()}`}
								className="w-full bg-paper border border-line rounded-lg px-3 py-2 text-sm focus:border-accent outline-none"
								disabled={submitting}
							/>
						</div>

						{error && <p className="text-sm text-danger">{error}</p>}

						<div className="flex gap-2 pt-4">
							<Button
								variant="primary"
								disabled={!value || submitting}
								onClick={(e) => {
									e.preventDefault();
									void handleSubmit();
								}}
							>
								{submitting && <Loader2 size={14} className="animate-spin" />}
								Submit value
							</Button>
							<Button onClick={() => navigate(`/instances/${instanceId}`)}>Cancel</Button>
						</div>
					</form>
				)}

				<div className="mt-8 p-4 bg-panel rounded-lg border border-line">
					<p className="text-xs text-muted">
						<strong>Destination:</strong> {request.destinationScope}
						<br />
						{request.sourceNode && (
							<>
								<strong>Read on:</strong> {request.sourceNode}
								<br />
							</>
						)}
						{request.consumedNode && (
							<>
								<strong>Written on:</strong> {request.consumedNode}
								<br />
							</>
						)}
						<strong>One-shot:</strong> {request.oneShot ? "Yes, deleted after use" : "Reusable"}
						<br />
						<strong>Requested:</strong> {stamp(request.createdAt)}
						<br />
						{request.consumedAt && (
							<>
								<strong>Used:</strong> {stamp(request.consumedAt)}
								<br />
							</>
						)}
						<strong>Expires:</strong> {new Date(request.expiresAt).toLocaleString()}
					</p>
				</div>
			</div>
		</div>
	);
}
