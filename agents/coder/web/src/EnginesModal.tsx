import { useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import { isClaudeEngine, missingWriteFlag } from "@proagentstore/sdk/ui";
import type { CodingEngine, EngineAuth } from "./types";
import { engineContinuityNote } from "./engine-continuity";
import { engineAttributionNote } from "./engine-attribution-note";
import { engineInvocationNote } from "./engine-invocation-mode";
import { engineMeteringNote } from "./engine-metering-note";
import { Cpu, Gauge, History, Trash2, Wallet } from "lucide-react";
import Button from "./Button";

/** The engine's vault-key name shown in the api-key option label. */
function apiKeyName(command: string): string {
	for (const t of command.trim().split(/\s+/)) {
		const base = (t.split("/").pop() || "").toLowerCase();
		if (base.startsWith("claude")) return "Anthropic";
		if (base.startsWith("gemini")) return "Google";
		if (base.startsWith("grok")) return "xAI";
		if (base.startsWith("codex")) return "OpenAI";
	}
	return "provider";
}

/**
 * Instance-wide engine presets editor: label + launch command + sign-in method
 * per engine, and which one is the default. Sign-in applies on the next session
 * start/Restart (the engine process gets its credentials at spawn).
 */
export default function EnginesModal({ instanceId, engines: initial, defaultEngineId: initialDefault, onClose, onSaved }: {
	instanceId: string;
	engines: CodingEngine[];
	defaultEngineId: string;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [engines, setEngines] = useState<CodingEngine[]>(initial.map((e) => ({ ...e })));
	const [defaultId, setDefaultId] = useState(initialDefault);
	const [saving, setSaving] = useState(false);
	/**
	 * Is a `claude setup-token` stored? (#551)
	 *
	 * `null` until the lookup lands, and it STAYS null if the lookup fails — the attribution note
	 * then states both outcomes instead of picking one. This is read rather than assumed because
	 * `auto` is the default mode and it means two different things depending on this single fact:
	 * with a token the engine runs on the subscription and Usage can name the payer; without one it
	 * falls back to the machine's own login and every turn lands in "Payer not established", which
	 * is where 99.62% of a real account's value ended up with nothing on any surface saying why.
	 */
	const [hasClaudeCodeToken, setHasClaudeCodeToken] = useState<boolean | null>(null);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	useEffect(() => {
		let live = true;
		void api<{ providers?: Array<{ id: string; hasKey?: boolean }> }>("/v1/keys/status")
			.then((d) => {
				if (live) setHasClaudeCodeToken(!!d.providers?.find((p) => p.id === "claude-code")?.hasKey);
			})
			// A failed lookup leaves it null, which the note renders as "it depends" — the honest
			// reading. Never false: "no token saved" is a claim, and a network error is not evidence.
			.catch(() => {});
		return () => { live = false; };
	}, []);

	const update = (i: number, patch: Partial<CodingEngine>) =>
		setEngines((prev) => prev.map((e, j) => (j === i ? { ...e, ...patch } : e)));

	const save = async () => {
		setSaving(true);
		try {
			await api(`/v1/instances/${instanceId}/coding/engines`, {
				method: "PUT",
				body: JSON.stringify({ engines, defaultEngineId: defaultId }),
			});
			onSaved();
			onClose();
		} catch (e) {
			alert("Save failed: " + (e instanceof Error ? e.message : String(e)));
		}
		setSaving(false);
	};

	return (
		<div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4">
			<div className="bg-panel border border-line rounded-t-2xl sm:rounded-2xl w-full sm:max-w-2xl max-h-[85dvh] overflow-y-auto overscroll-contain p-4" style={{ WebkitOverflowScrolling: "touch" }}>
				<div className="flex items-center justify-between gap-3 mb-1.5">
					<h3 className="text-base font-bold flex items-center gap-1.5"><Cpu size={16} /> CLI engines</h3>
					<button type="button" onClick={onClose} className="text-muted hover:text-ink text-lg leading-none">✕</button>
				</div>
				<p className="text-xs text-muted mb-3">
					Each engine is a CLI the agent can run. <b>Sign-in</b> picks whose credentials it launches with — tokens/keys come from{" "}
					<b>Profile → API Keys</b> and apply on the next session start or Restart.
				</p>

				<div className="flex flex-col gap-2">
					{engines.map((e, i) => {
						const isClaude = isClaudeEngine(e.command);
						const signInId = `engine-${e.id}-auth`;
						const needsWrite = missingWriteFlag(e.command);
						const invocation = engineInvocationNote(e.command);
						const continuity = engineContinuityNote(e.command);
						const attribution = engineAttributionNote(e.command, e.auth, hasClaudeCodeToken);
						const metering = engineMeteringNote(e.command);
						return (
							<div key={e.id} className="bg-paper border border-line rounded-lg p-2.5">
								<div className="flex gap-1.5 items-center flex-wrap">
										<input
											value={e.label}
											onChange={(ev) => update(i, { label: ev.target.value })}
											aria-label="Engine label"
											placeholder="Label"
											className="bg-panel border border-line rounded-lg px-2 py-1.5 text-sm font-semibold w-36"
										/>
										<input
											value={e.command}
											onChange={(ev) => update(i, { command: ev.target.value })}
											aria-label="Engine launch command"
											placeholder="Launch command"
											className="bg-panel border border-line rounded-lg px-2 py-1.5 text-xs font-mono flex-1 min-w-40"
										/>
									{invocation && (
										<span
											title={invocation.detail}
											className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-normal ${
												invocation.mode === "structured" ? "border-success-line bg-success-soft text-success" : "border-line bg-line/50 text-muted"
											}`}
										>
											{invocation.label}
										</span>
									)}
									<button
										type="button"
										onClick={() => setEngines((prev) => prev.filter((_, j) => j !== i))}
										disabled={engines.length <= 1}
										title="Remove engine"
										className="text-muted hover:text-danger disabled:opacity-30"
									>
										<Trash2 size={14} />
									</button>
								</div>
								<div className="flex gap-3 items-center mt-1.5 flex-wrap">
									<label htmlFor={signInId} className="text-xs text-muted font-bold shrink-0">Sign-in</label>
									<select
										id={signInId}
										value={e.auth ?? "auto"}
										onChange={(ev) => update(i, { auth: ev.target.value as EngineAuth })}
										className="bg-panel border border-line rounded-lg px-2 py-1 text-xs"
									>
										<option value="auto">{isClaude ? "Auto — subscription token if saved, else machine login" : "Auto — this machine's login"}</option>
										<option value="machine">Machine login only</option>
										{isClaude && <option value="subscription">Subscription token (Claude Code key)</option>}
										<option value="api-key">{apiKeyName(e.command)} API key (per-token billing)</option>
									</select>
									<label className="text-xs text-muted flex items-center gap-1 ml-auto">
										<input type="radio" name="default-engine" checked={defaultId === e.id} onChange={() => setDefaultId(e.id)} />
										Default
									</label>
								</div>
								{continuity && (
									// Stated for BOTH answers, in muted text rather than warning text (#449).
									// One-shot is the design, not a defect — a non-interactive binary has nothing
									// to keep alive — so it must not shout next to the read-only warning below,
									// which IS a misconfiguration the user should fix. Saying nothing for the
									// persistent case would leave the reader to infer the difference from
									// silence, which is the gap this closes.
									<div className="text-xs text-muted mt-1.5 flex items-start gap-1.5">
										<History size={12} className="mt-0.5 shrink-0" aria-hidden />
										<span>
											<b>{continuity.label}.</b> {continuity.detail}
										</span>
									</div>
								)}
								{metering && (
									// Muted for BOTH answers, like the continuity line above and for the same
									// reason (#556): an unmeasurable engine is a legitimate choice, not a
									// misconfiguration — `DEFAULT_ENGINES` ships codex and grok deliberately —
									// so it must not shout next to the read-only warning below, which IS
									// something to fix. Saying nothing for the measured case would leave the
									// difference to be inferred from silence, which is how "tmux is cheaper"
									// nearly became a conclusion somebody drew from a missing row.
									<div className="text-xs text-muted mt-1.5 flex items-start gap-1.5">
										<Gauge size={12} className="mt-0.5 shrink-0" aria-hidden />
										<span>
											<b>{metering.label}.</b> {metering.detail}
										</span>
									</div>
								)}
								{attribution && (
									// Muted like the two notes above, for the third time and the same reason: every
									// one of these modes is a legitimate choice. `machine`, and `auto` with no token
									// saved, are not misconfigurations — the second is the DEFAULT, and it works. The
									// only thing wrong was that nothing said what they cost the Usage page: three of
									// the four modes can resolve to a login the platform cannot attribute, and on the
									// account this was measured on that was 99.62% of the value. Warning styling stays
									// reserved for the read-only flag below, which IS a thing to fix.
									<div className="text-xs text-muted mt-1.5 flex items-start gap-1.5">
										<Wallet size={12} className="mt-0.5 shrink-0" aria-hidden />
										<span>
											<b>{attribution.label}.</b> {attribution.detail}
										</span>
									</div>
								)}
								{needsWrite && (
									<div className="text-xs text-warning mt-1.5 flex items-start gap-1.5">
										<span aria-hidden>⚠</span>
										<span>
											Read-only — this engine can explore the repo but <b>cannot edit files</b> (headless has no
											terminal to approve with). Add{" "}
											<button
												type="button"
												onClick={() => update(i, { command: `${e.command.trim()} ${needsWrite}` })}
												className="font-mono underline decoration-dotted"
											>
												{needsWrite}
											</button>
											.
										</span>
									</div>
								)}
							</div>
						);
					})}
				</div>

				<Button size="md" className="mt-2" onClick={() => setEngines((prev) => [...prev, { id: `engine-${prev.length + 1}`, label: "", command: "" }])}>
					+ Add engine
				</Button>

				<div className="flex gap-2 justify-end mt-4">
					<Button size="md" onClick={onClose}>Cancel</Button>
					<Button variant="primary" size="md" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
				</div>
			</div>
		</div>
	);
}
