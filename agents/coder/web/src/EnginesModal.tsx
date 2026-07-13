import { useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import type { CodingEngine, EngineAuth } from "./types";
import { Cpu, Trash2 } from "lucide-react";

/** Mirror of the API's deriveClientType, just enough to pick the right auth options. */
function clientOf(command: string): "claude" | "other" {
	for (const t of command.trim().split(/\s+/)) {
		if (!t || t.includes("=") || t.startsWith("-")) continue;
		const base = (t.split("/").pop() || "").toLowerCase();
		if (["npx", "bunx", "pnpm", "yarn", "npm", "bun", "env", "exec", "dlx", "run", "sudo", "time"].includes(base)) continue;
		return base.startsWith("claude") ? "claude" : "other";
	}
	return "claude";
}

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

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

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
			<div className="bg-panel border border-line rounded-t-xl sm:rounded-xl w-full sm:max-w-2xl max-h-[88vh] overflow-auto p-4">
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
						const isClaude = clientOf(e.command) === "claude";
						const signInId = `engine-${e.id}-auth`;
						return (
							<div key={e.id} className="bg-paper border border-line rounded-lg p-2.5">
								<div className="flex gap-1.5 items-center flex-wrap">
									<input
										value={e.label}
										onChange={(ev) => update(i, { label: ev.target.value })}
										placeholder="Label"
										className="bg-panel border border-line rounded-lg px-2 py-1.5 text-sm font-semibold w-36"
									/>
									<input
										value={e.command}
										onChange={(ev) => update(i, { command: ev.target.value })}
										placeholder="Launch command"
										className="bg-panel border border-line rounded-lg px-2 py-1.5 text-xs font-mono flex-1 min-w-40"
									/>
									<button
										type="button"
										onClick={() => setEngines((prev) => prev.filter((_, j) => j !== i))}
										disabled={engines.length <= 1}
										title="Remove engine"
										className="text-muted hover:text-red disabled:opacity-30"
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
							</div>
						);
					})}
				</div>

				<button
					type="button"
					onClick={() => setEngines((prev) => [...prev, { id: `engine-${prev.length + 1}`, label: "", command: "" }])}
					className="text-xs px-2.5 py-1.5 rounded-lg border border-line text-muted font-semibold mt-2"
				>
					+ Add engine
				</button>

				<div className="flex gap-2 justify-end mt-4">
					<button type="button" onClick={onClose} className="text-xs px-3 py-1.5 rounded-md border border-line text-muted font-semibold">Cancel</button>
					<button type="button" onClick={save} disabled={saving} className="text-xs px-3 py-1.5 rounded-md bg-accent text-white font-bold disabled:opacity-50">{saving ? "Saving…" : "Save"}</button>
				</div>
			</div>
		</div>
	);
}
