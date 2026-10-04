import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import { AlertCircle, Loader2, CheckCircle } from "lucide-react";
import Button from "./Button";
import type { ListSecureInputsResponse, SecureInputView } from "../lib/types";

export default function SecureInputRequests({ instanceId }: { instanceId: string }) {
	const [requests, setRequests] = useState<SecureInputView[]>([]);
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState("");
	const [error, setError] = useState("");
	const [note, setNote] = useState("");

	const load = useCallback(async () => {
		try {
			const res = await api<ListSecureInputsResponse>(`/v1/instances/${instanceId}/secure-inputs`);
			const pending = (res.requests ?? []).filter((r) => r.status === "pending" || r.status === "ready");
			setRequests(pending);
			setDrafts((prev) => {
				const next: Record<string, string> = {};
				for (const r of pending) {
					next[r.id] = prev[r.id] ?? "";
				}
				return next;
			});
		} catch {
			// Silent fail: poll will try again
		}
	}, [instanceId]);

	useEffect(() => {
		void load();
		const t = setInterval(() => void load(), 20_000);
		return () => clearInterval(t);
	}, [load]);

	const submit = async (req: SecureInputView) => {
		setBusy(req.id);
		setError("");
		setNote("");
		const value = drafts[req.id] ?? "";

		if (!value) {
			setError("Enter a value");
			setBusy("");
			return;
		}

		try {
			await api(`/v1/instances/${instanceId}/secure-inputs/${req.id}/submit`, {
				method: "POST",
				body: JSON.stringify({ value }),
			});
			setNote("Sent successfully.");
			setDrafts((prev) => {
				const next = { ...prev };
				delete next[req.id];
				return next;
			});
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not submit");
		} finally {
			setBusy("");
			await load();
		}
	};

	if (!requests.length) return note || error ? <p className={`text-xs px-3 py-2 ${error ? "text-danger" : "text-muted"}`}>{error || note}</p> : null;

	return (
		<div className="flex flex-col gap-2 px-2 pt-2 border-t border-line">
			{requests.map((req) => (
				<div key={req.id} className="border border-warning-line bg-panel rounded-xl p-3 text-sm">
					<div className="flex items-start gap-2 mb-2">
						<AlertCircle size={15} className="text-warning shrink-0 mt-0.5" />
						<div className="min-w-0">
							<p className="font-semibold">{req.label}</p>
							<p className="text-2xs text-muted">{req.status === "ready" ? "Ready for injection" : "Waiting for value"}</p>
						</div>
					</div>

					{req.purpose && <p className="text-sm mb-3 text-muted">{req.purpose}</p>}

					<div className="flex flex-col gap-2">
						<div className="flex flex-col gap-1">
							<label htmlFor={`secure-input-${req.id}`} className="text-2xs font-semibold text-muted">
								{req.label} <span className="text-warning">*</span>
							</label>
							<input
								id={`secure-input-${req.id}`}
								type="password"
								value={drafts[req.id] ?? ""}
								autoComplete="off"
								onChange={(e) => setDrafts((prev) => ({ ...prev, [req.id]: e.target.value }))}
								className="w-full bg-paper border border-line rounded-lg px-2 py-1.5 text-sm focus:border-accent outline-none"
								disabled={req.status === "ready"}
							/>
						</div>
					</div>

					{req.status === "ready" && (
						<div className="flex items-center gap-2 mt-2 text-success text-sm">
							<CheckCircle size={14} />
							<span>Submitted and ready for injection</span>
						</div>
					)}

					{error && <p className="text-2xs text-danger mt-1">{error}</p>}
					{req.status !== "ready" && (
						<div className="flex gap-2 mt-2">
							<Button variant="primary" disabled={busy === req.id || !drafts[req.id]} onClick={() => void submit(req)}>
								{busy === req.id && <Loader2 size={12} className="animate-spin" />}
								Submit value
							</Button>
						</div>
					)}
				</div>
			))}
			{note && <p className="text-xs text-muted px-1">{note}</p>}
		</div>
	);
}
