import { useState } from "react";
import Button from "./Button";
import { chooseDeploy, clearPatch, draftChanged, draftFromSaved, draftIsValid, draftProblems, emptyRow, type GateRow, modeCopy, rowForServerError, savePatch, WORKFLOWS_MAX } from "../lib/releaseGate";
import type { InstanceReleaseNotesResponse } from "../lib/types";

type Patch = ReturnType<typeof savePatch> | ReturnType<typeof clearPatch>;

interface Props {
	/** The gate as the server last returned it. The editor never shows anything it has not been given. */
	saved: InstanceReleaseNotesResponse["settings"]["requiredWorkflows"];
	gate: InstanceReleaseNotesResponse["gate"];
	/** Sends the patch to the PUT route and resolves once the server's answer is the new `saved`. Rejects with the server's message. */
	send: (patch: Patch) => Promise<void>;
	/** Tests open the editor, or the "fix it" state, without a click. */
	defaultEditing?: boolean;
	defaultTried?: boolean;
}

const input = "w-full min-w-0 bg-paper border border-line rounded-lg px-3 py-2 text-sm";
const errorText = (e: unknown) => (e instanceof Error ? e.message : "That did not save.");

/**
 * The exact-SHA release gate (#1347): which workflows must succeed for the pushed commit, and which job
 * and step prove the deploy. It sends `requiredWorkflows` alone, so a gate edit cannot change on/off or
 * the channels, and a refusal leaves the last saved gate showing. The server is the validation authority;
 * the row checks (`draftProblems`) are the same rules, run early to place the message beside the row.
 */
export default function ReleaseGateEditor({ saved, gate, send, defaultEditing = false, defaultTried = false }: Props) {
	const [editing, setEditing] = useState(defaultEditing);
	const [rows, setRows] = useState<GateRow[]>(() => draftFromSaved(saved));
	const [tried, setTried] = useState(defaultTried);
	const [busy, setBusy] = useState(false);
	const [confirmClear, setConfirmClear] = useState(false);
	const [serverError, setServerError] = useState("");
	const mode = modeCopy(gate);
	const problems = draftProblems(rows);
	const serverRow = serverError ? rowForServerError(serverError, rows) : null;

	const open = () => {
		setRows(draftFromSaved(saved));
		setTried(false);
		setServerError("");
		setEditing(true);
	};
	const cancel = () => {
		setRows(draftFromSaved(saved));
		setServerError("");
		setEditing(false);
	};
	const change = (i: number, over: Partial<GateRow>) => setRows((rs) => rs.map((r, at) => (at === i ? { ...r, ...over } : r)));

	const submit = async (patch: Patch, after: () => void) => {
		setBusy(true);
		setServerError("");
		try {
			await send(patch);
			after();
		} catch (e) {
			setServerError(errorText(e));
		} finally {
			setBusy(false);
		}
	};
	const save = () => {
		setTried(true);
		if (!draftIsValid(rows)) return;
		void submit(savePatch(rows), () => setEditing(false));
	};

	return (
		<div className="mb-3" data-testid="release-gate" data-gate-mode={mode.mode}>
			<div className="text-xs text-muted mb-1">Delivery mode</div>
			<div className={`border rounded-lg px-3 py-2 mb-2 ${mode.mode === "setup_needed" ? "border-warning-line" : "border-line"} bg-paper`}>
				<p className="text-sm font-semibold">{mode.title}</p>
				<p className="text-2xs text-muted-soft mt-0.5">{mode.body}</p>
			</div>

			{!editing ? (
				<>
					{saved?.length ? (
						<ul className="flex flex-col gap-1 mb-2" aria-label="Required workflows">
							{saved.map((w) => (
								<li key={w.path} className="text-xs bg-paper border border-line rounded-lg px-2.5 py-2 min-w-0">
									<span className="break-all">{w.path}</span>
									<span className="text-muted-soft"> · {w.role === "production_deploy" ? "production deploy" : "must succeed"}</span>
									{w.role === "production_deploy" && (
										<div className="text-muted-soft mt-0.5 break-words">
											{w.jobName && w.stepName ? (
												<>
													job <code>{w.jobName}</code> · step <code>{w.stepName}</code>
												</>
											) : (
												<span className="text-danger">no deploy job and step named yet</span>
											)}
										</div>
									)}
								</li>
							))}
						</ul>
					) : (
						<p className="text-xs text-muted mb-2">No gate configured.</p>
					)}
					{confirmClear ? (
						<div role="alertdialog" aria-label="Clear the gate" className="border border-warning-line rounded-lg px-3 py-2 mb-2">
							<p className="text-xs mb-2">Without a gate, notes go back to status notes after each run and no deploy is verified. Queued notes for the gate are cancelled.</p>
							<div className="flex gap-2 flex-wrap">
								<Button variant="danger" disabled={busy} onClick={() => void submit(clearPatch(), () => setConfirmClear(false))}>
									{busy ? "Clearing…" : "Clear the gate"}
								</Button>
								<Button disabled={busy} onClick={() => setConfirmClear(false)}>
									Keep it
								</Button>
							</div>
						</div>
					) : (
						<div className="flex gap-2 flex-wrap">
							<Button onClick={open}>{saved?.length ? (gate.state === "configuration_required" ? "Add the deploy job and step" : "Edit gate") : "Set up a gate"}</Button>
							{saved?.length ? (
								<Button variant="ghost" onClick={() => setConfirmClear(true)}>
									Clear gate
								</Button>
							) : null}
						</div>
					)}
				</>
			) : (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						save();
					}}
					aria-label="Edit the release gate"
				>
					<p className="text-2xs text-muted-soft mb-2">Exact workflow files that must all succeed for the pushed commit. Mark one as the production deploy and name its job and step exactly as GitHub Actions shows them.</p>
					<div className="flex flex-col gap-2 mb-2">
						{rows.map((r, i) => {
							const message = tried ? problems.rows[i] : undefined;
							const shown = message ?? (serverRow === i ? serverError : undefined);
							const errId = `gate-row-${i}-error`;
							return (
								// biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until saved; their order is their identity.
								<fieldset key={i} className="border border-line rounded-lg px-2.5 py-2 min-w-0" data-testid={`gate-row-${i}`}>
									<legend className="text-2xs text-muted-soft px-1">Workflow {i + 1}</legend>
									<div className="flex gap-2 flex-wrap items-center">
										<input
											aria-label={`Workflow ${i + 1} path`}
											aria-invalid={shown ? true : undefined}
											aria-describedby={shown ? errId : undefined}
											placeholder=".github/workflows/ci.yml"
											value={r.path}
											onChange={(e) => change(i, { path: e.target.value })}
											className={`${input} flex-1 sm:min-w-[14rem]`}
										/>
										<label className="flex items-center gap-1.5 text-xs shrink-0">
											<input type="radio" name="gate-deploy" checked={r.role === "production_deploy"} onChange={() => setRows((rs) => chooseDeploy(rs, i))} />
											Production deploy
										</label>
										<button type="button" className="text-xs text-muted hover:text-danger shrink-0" aria-label={`Remove workflow ${i + 1}`} onClick={() => setRows((rs) => rs.filter((_, at) => at !== i))}>
											Remove
										</button>
									</div>
									{r.role === "production_deploy" && (
										<div className="flex gap-2 flex-wrap mt-2">
											<input aria-label="Deploy job name" aria-invalid={shown ? true : undefined} aria-describedby={shown ? errId : undefined} placeholder="Job name, e.g. deploy" value={r.jobName} onChange={(e) => change(i, { jobName: e.target.value })} className={`${input} flex-1 sm:min-w-[10rem]`} />
											<input aria-label="Deploy step name" aria-invalid={shown ? true : undefined} aria-describedby={shown ? errId : undefined} placeholder="Step name, e.g. Upload to R2" value={r.stepName} onChange={(e) => change(i, { stepName: e.target.value })} className={`${input} flex-1 sm:min-w-[10rem]`} />
										</div>
									)}
									{shown && (
										<p id={errId} role="alert" className="text-xs text-danger mt-1 break-words">
											{shown}
										</p>
									)}
								</fieldset>
							);
						})}
					</div>
					{(tried && problems.form) || (serverError && serverRow === null) ? (
						<p role="alert" className="text-xs text-danger mb-2 break-words">
							{(tried && problems.form) || serverError}
						</p>
					) : null}
					<div className="flex gap-2 flex-wrap items-center">
						<Button variant="ghost" disabled={rows.length >= WORKFLOWS_MAX} onClick={() => setRows((rs) => [...rs, emptyRow("check")])}>
							Add workflow
						</Button>
						<span className="flex-1" />
						<Button onClick={cancel} disabled={busy}>
							Cancel
						</Button>
						<Button type="submit" variant="primary" disabled={busy || !draftChanged(rows, saved)}>
							{busy ? "Saving…" : "Save gate"}
						</Button>
					</div>
				</form>
			)}
			{!editing && serverError ? (
				<p role="alert" className="text-xs text-danger mt-1 break-words">
					{serverError}
				</p>
			) : null}
		</div>
	);
}
