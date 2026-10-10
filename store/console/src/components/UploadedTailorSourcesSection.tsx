import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Button from "./Button";
import Card from "./Card";
import LoadFailed from "./LoadFailed";
import {
	shortHash,
	uploadedTailorReadinessMessage,
	uploadedTailorSourcesApi,
	type UploadedTailorFile,
	type UploadedTailorReadiness,
	type UploadedTailorSource,
	type UploadedTailorSourceRole,
} from "../lib/uploadedTailorSources";

const ROLES: Array<{ role: UploadedTailorSourceRole; label: string }> = [
	{ role: "resume", label: "Résumé" },
	{ role: "profile", label: "Profile" },
];

const bytes = (size: number | undefined) =>
	typeof size !== "number" ? "" : size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;

/**
 * Owner-facing selection of exact Instance Files for Application Tailor.
 *
 * This is intentionally separate from FilesSection: that component owns upload/preview/delete,
 * while this component records a source-role decision and exposes the Worker’s fail-closed
 * readiness verdict. Neither component receives source bytes.
 */
export default function UploadedTailorSourcesSection({ instanceId }: { instanceId: string }) {
	const [files, setFiles] = useState<UploadedTailorFile[] | null>(null);
	const [sources, setSources] = useState<UploadedTailorSource[] | null>(null);
	const [readiness, setReadiness] = useState<UploadedTailorReadiness | null>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState<UploadedTailorSourceRole | null>(null);

	const load = useCallback(async () => {
		setError("");
		// A failed refresh must not leave the last answer visible as if it were current.  In
		// particular, a file can be deleted between the previous readiness probe and this one.
		setFiles(null);
		setSources(null);
		setReadiness(null);
		try {
			const [fileResult, selectionResult, readinessResult] = await Promise.all([
				uploadedTailorSourcesApi.listFiles(api, instanceId),
				uploadedTailorSourcesApi.listSelections(api, instanceId),
				uploadedTailorSourcesApi.readiness(api, instanceId),
			]);
			setFiles(fileResult.files || []);
			setSources(selectionResult.sources || []);
			setReadiness(readinessResult);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [instanceId]);

	useEffect(() => { void load(); }, [load]);

	const select = async (role: UploadedTailorSourceRole, fileId: string) => {
		if (!fileId) return;
		setBusy(role);
		setError("");
		try {
			await uploadedTailorSourcesApi.select(api, instanceId, role, fileId);
			await load();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(null);
		}
	};

	const clear = async (role: UploadedTailorSourceRole) => {
		setBusy(role);
		setError("");
		try {
			await uploadedTailorSourcesApi.clear(api, instanceId, role);
			await load();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(null);
		}
	};

	if (error && !readiness) return <Card className="mb-3 sm:mb-4"><LoadFailed what="uploaded résumé sources" detail={error} onRetry={load} testId="uploaded-tailor-sources-load-failed" compact /></Card>;
	if (!files || !sources || !readiness) return <Card className="mb-3 sm:mb-4"><p className="text-sm text-muted">Loading uploaded résumé sources…</p></Card>;

	const byRole = new Map(sources.map((source) => [source.role, source]));
	const readinessByRole = new Map(readiness.sources.map((source) => [source.role, source]));
	const hasSelection = sources.length > 0;

	return (
		<Card className="mb-3 sm:mb-4" data-testid="uploaded-tailor-sources">
			<h3 className="text-base font-bold">Uploaded résumé sources</h3>
			<p className="text-xs text-muted mt-1">Choose the exact files Application Tailor may use. Files are checked by ID and provenance; their contents are never shown here.</p>
			{error && <LoadFailed what="the latest uploaded-source state" detail={error} onRetry={load} compact />}
			{hasSelection ? (
				<div className={`mt-3 text-xs rounded-lg border px-3 py-2 ${readiness.ready ? "border-success-line bg-success-soft text-success" : "border-warning-line bg-warning-soft text-warning"}`}>
					{uploadedTailorReadinessMessage(readiness)}
				</div>
			) : <p className="mt-3 text-xs text-muted">No uploaded source is selected. Local workspace sources remain the active mode.</p>}

			<div className="mt-3 flex flex-col gap-3">
				{ROLES.map(({ role, label }) => {
					const selected = byRole.get(role);
					const state = readinessByRole.get(role);
					return (
						<div key={role} className="rounded-lg border border-line p-3">
							<div className="flex justify-between gap-2 items-baseline">
								<label htmlFor={`uploaded-tailor-${role}-${instanceId}`} className="text-sm font-semibold">{label}</label>
								{state?.isStale && <span className="text-xs text-danger font-semibold">Needs re-selection</span>}
							</div>
							<select
								id={`uploaded-tailor-${role}-${instanceId}`}
								aria-label={`${label} uploaded file`}
								value={selected?.id ?? ""}
								disabled={busy !== null}
								onChange={(event) => { if (event.target.value) void select(role, event.target.value); }}
								className="mt-2 w-full bg-paper border border-line rounded-lg px-2 py-1.5 text-sm"
							>
								<option value="">Select an uploaded file…</option>
								{files.map((file) => <option key={file.id} value={file.id}>{file.name}{file.mimeType ? ` · ${file.mimeType}` : ""}{bytes(file.size) ? ` · ${bytes(file.size)}` : ""}</option>)}
							</select>
							{selected && <p className="mt-2 text-xs text-muted">Selected: {selected.name} · {selected.extractionStatus ?? "extraction status unavailable"}</p>}
							{state?.provenance && (
								<p className="mt-1 text-xs text-muted-soft break-words">
									Version {state.provenance.version ?? "unavailable"} · PDF SHA-256 {shortHash(state.provenance.originalHash)} · text SHA-256 {shortHash(state.provenance.extractedHash)}{state.provenance.extractedAt ? ` · extracted ${new Date(state.provenance.extractedAt).toLocaleString()}` : ""}
								</p>
							)}
							{state?.blockers.length ? <p className="mt-1 text-xs text-warning">{state.blockers.join(" · ").replaceAll("_", " ")}</p> : null}
							{selected && <div className="mt-2"><Button size="sm" variant="danger" disabled={busy !== null} onClick={() => void clear(role)}>{busy === role ? "Working…" : "Clear selection"}</Button></div>}
						</div>
					);
				})}
			</div>
		</Card>
	);
}
