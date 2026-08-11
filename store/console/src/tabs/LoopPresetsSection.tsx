import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import { ChevronDown, ChevronUp, Plus, Repeat, Trash2 } from "lucide-react";
import Button from "../components/Button";
import Card from "../components/Card";
import {
	MAX_LOOP_PRESETS,
	addPreset,
	canResetPresets,
	incompleteCount,
	movePreset,
	presetSourceLabel,
	presetsDirty,
	removePreset,
	saveablePresets,
	updatePreset,
	type LoopPreset,
	type LoopPresetSource,
} from "../lib/loopPresets";

/**
 * Loop presets — the shortcut objectives offered wherever a loop starts (#234).
 *
 * Deliberately a sibling of the CLI-engines editor in spirit, and deliberately NOT named like it:
 * the "presets" a user found in the console until now were the engine launch commands, which is a
 * different feature with a confusingly similar name. This card says what these presets DO.
 *
 * All list logic is in ../lib/loopPresets so the parts that are only checkable by clicking — id
 * collisions, reorder at the ends, what a half-typed row does on save — are unit-tested instead.
 */

type Resolved = { presets: LoopPreset[]; source: LoopPresetSource; driver: string };

export default function LoopPresetsSection({ instanceId }: { instanceId: string }) {
	const [list, setList] = useState<LoopPreset[]>([]);
	const [saved, setSaved] = useState<LoopPreset[]>([]);
	const [source, setSource] = useState<LoopPresetSource>("default");
	const [loaded, setLoaded] = useState(false);
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState("");
	const [open, setOpen] = useState(false);

	const load = useCallback(async () => {
		try {
			const r = await api<Resolved>(`/v1/instances/${instanceId}/loop-presets`);
			setList(r.presets ?? []);
			setSaved(r.presets ?? []);
			setSource(r.source ?? "default");
		} catch {
			/* a failed read leaves the card in its empty state rather than an error wall */
		} finally {
			setLoaded(true);
		}
	}, [instanceId]);

	useEffect(() => {
		void load();
	}, [load]);

	const persist = async (next: LoopPreset[]) => {
		setBusy(true);
		setMsg("");
		try {
			const r = await api<Resolved>(`/v1/instances/${instanceId}/loop-presets`, {
				method: "PUT",
				body: JSON.stringify({ presets: next }),
			});
			// Trust the SERVER's list back, not the local one: it sanitizes ids and drops rows, and
			// showing the un-sanitized version would make the next edit act on a row that isn't there.
			setList(r.presets ?? []);
			setSaved(r.presets ?? []);
			setSource(r.source ?? "default");
			setMsg("Saved.");
		} catch (e) {
			setMsg(e instanceof Error ? e.message : "Could not save.");
		} finally {
			setBusy(false);
		}
	};

	if (!loaded) return null;

	const dirty = presetsDirty(list, saved);
	const incomplete = incompleteCount(list);

	return (
		<Card className="mb-3 sm:mb-4">
			<button type="button" onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between gap-2 text-left">
				<span>
					<span className="text-base font-bold flex items-center gap-1.5"><Repeat size={15} /> Loop presets</span>
					<span className="block text-sm text-muted mt-0.5">
						One-tap objectives in the Loop form — on the Assistant tab and the Coding tab.{" "}
						{list.length ? `${list.length} configured.` : "None yet."}
					</span>
				</span>
				{open ? <ChevronUp size={16} className="text-muted shrink-0" /> : <ChevronDown size={16} className="text-muted shrink-0" />}
			</button>

			{open && (
				<div className="mt-3">
					<p className="text-xs text-muted mb-2">{presetSourceLabel(source, list.length)}</p>
					<div className="flex flex-col gap-2">
						{list.map((p, i) => (
							<div key={p.id} className="border border-line rounded-lg p-2 flex flex-col gap-1.5">
								<div className="flex items-center gap-1.5">
									<input
										value={p.label}
										onChange={(e) => setList((l) => updatePreset(l, p.id, { label: e.target.value }))}
										placeholder="Button label (e.g. Fix bugs)"
										aria-label="Preset label"
										className="flex-1 min-w-0 text-sm font-semibold bg-paper border border-line rounded-lg px-2.5 py-1.5"
									/>
									<Button
										size="icon"
										onClick={() => setList((l) => movePreset(l, p.id, -1))}
										disabled={i === 0}
										title="Move up"
										aria-label={`Move ${p.label || "preset"} up`}
									>
										<ChevronUp size={13} />
									</Button>
									<Button
										size="icon"
										onClick={() => setList((l) => movePreset(l, p.id, 1))}
										disabled={i === list.length - 1}
										title="Move down"
										aria-label={`Move ${p.label || "preset"} down`}
									>
										<ChevronDown size={13} />
									</Button>
									<Button
										variant="danger"
										size="icon"
										onClick={() => setList((l) => removePreset(l, p.id))}
										title="Remove"
										aria-label={`Remove ${p.label || "preset"}`}
									>
										<Trash2 size={13} />
									</Button>
								</div>
								<textarea
									value={p.objective}
									onChange={(e) => setList((l) => updatePreset(l, p.id, { objective: e.target.value }))}
									placeholder="What the agent should work on when this is tapped…"
									aria-label="Preset objective"
									rows={2}
									className="w-full text-sm bg-paper border border-line rounded-lg px-2.5 py-1.5 resize-none"
								/>
							</div>
						))}
					</div>

					<div className="flex flex-wrap items-center gap-2 mt-3">
						<Button
							onClick={() => setList((l) => addPreset(l))}
							disabled={list.length >= MAX_LOOP_PRESETS}
						>
							<Plus size={13} /> Add preset
						</Button>
						<Button
							variant="primary"
							onClick={() => void persist(saveablePresets(list))}
							disabled={busy || !dirty}
						>
							{busy ? "Saving…" : "Save presets"}
						</Button>
						{/* Only when there IS an override of your own — a reset that resets to what you are
						    already looking at is the confusion #232 removed elsewhere. */}
						{canResetPresets(source) && (
							<Button
								onClick={() => void persist([])}
								disabled={busy}
							>
								Reset to defaults
							</Button>
						)}
						{incomplete > 0 && (
							<span className="text-xs text-warning">
								{incomplete === 1 ? "One preset needs" : `${incomplete} presets need`} both a label and an objective — otherwise it won't be saved.
							</span>
						)}
						{msg && <span className="text-xs text-muted">{msg}</span>}
					</div>
				</div>
			)}
		</Card>
	);
}
