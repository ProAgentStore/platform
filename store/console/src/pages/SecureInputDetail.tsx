import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import { AlertCircle, Loader2, CheckCircle, ArrowLeft } from "lucide-react";
import Button from "../components/Button";
import type { SecureInputView } from "../lib/types";

export default function SecureInputDetail() {
	const { id: instanceId, requestId } = useParams<{ id: string; requestId: string }>();
	const navigate = useNavigate();
	const [request, setRequest] = useState<SecureInputView | null>(null);
	const [value, setValue] = useState("");
	const [loading, setLoading] = useState(true);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		const load = async () => {
			if (!instanceId || !requestId) return;
			try {
				setLoading(true);
				const res = await api<SecureInputView>(`/v1/instances/${instanceId}/secure-inputs/${requestId}`);
				setRequest(res);
			} catch (e) {
				setError(e instanceof Error ? e.message : "Failed to load request");
			} finally {
				setLoading(false);
			}
		};
		void load();
	}, [instanceId, requestId]);

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
				<p className="text-muted">Request not found</p>
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
						<p className="text-sm text-muted">{request.status}</p>
					</div>
				</div>
			</div>

			<div className="flex-1 p-6 max-w-2xl">
				{request.purpose && (
					<div className="mb-6 p-4 border border-line rounded-lg bg-panel">
						<p className="text-sm text-muted">{request.purpose}</p>
					</div>
				)}

				{request.status === "ready" ? (
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
							<p className="text-sm text-muted">This request exceeded its 24-hour TTL and is no longer valid.</p>
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
						<strong>One-shot:</strong> {request.oneShot ? "Yes, deleted after use" : "Reusable"}
						<br />
						<strong>Expires:</strong> {new Date(request.expiresAt).toLocaleString()}
					</p>
				</div>
			</div>
		</div>
	);
}
