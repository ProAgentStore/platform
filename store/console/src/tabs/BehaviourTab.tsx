import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@proagentstore/sdk/client";

/**
 * Behaviour tab (#225) — how the agent ACTS.
 *
 * A third thing, deliberately not folded into either neighbour: Settings is what the agent IS
 * (repo, engine, runner, triggers) and Knowledge is what it KNOWS. Character was previously
 * configurable nowhere, which is why an agent asked to be less technical wrote the preference into
 * Memory — a place meant for subject-matter knowledge.
 *
 * ## The fields come from the server
 *
 * `GET /v1/instances/behaviour-schema` returns the same table the prompt is assembled from, so a
 * new field appears here with no console change and the band text shown under a slider is
 * literally the instruction that will be sent. Restating the copy in the console is how the two
 * drift, and drift is the failure this whole feature exists to remove.
 */

type Value = number | string | boolean | string[];

interface Band {
	max: number;
	label: string;
	prompt: string;
}
interface Option {
	value: string;
	label: string;
	prompt: string;
}
interface Field {
	id: string;
	group: string;
	label: string;
	help?: string;
	type: "scale" | "choice" | "toggle" | "text" | "list" | "number";
	default: Value;
	bands?: Band[];
	options?: Option[];
	onPrompt?: string;
	offPrompt?: string;
	maxLength?: number;
	min?: number;
	max?: number;
	selfWritable: boolean;
}

const GROUPS: Array<{ id: string; label: string; blurb: string }> = [
	{ id: "style", label: "Style", blurb: "How it writes." },
	{ id: "reasoning", label: "Reasoning", blurb: "How it handles uncertainty and shows its work." },
	{ id: "formatting", label: "Formatting", blurb: "What its replies look like." },
	{ id: "interaction", label: "Interaction", blurb: "How it works with you." },
	{
		id: "guardrails",
		label: "Guardrails",
		// Stated in the UI, not just in code: the user should know which settings their agent can
		// change on request and which only they can.
		blurb: "Hard limits. The agent cannot change these itself, even if you ask it to in chat.",
	},
];

/** The band whose range contains this value — the instruction the slider actually selects. */
export function bandFor(field: Field, value: number): Band | undefined {
	return field.bands?.find((b) => value <= b.max) ?? field.bands?.[field.bands.length - 1];
}

/** Is this field configured, as opposed to sitting at the platform default? */
export function isSet(behaviour: Record<string, Value>, id: string): boolean {
	return Object.prototype.hasOwnProperty.call(behaviour, id);
}

export default function BehaviourTab({ instanceId }: { instanceId: string }) {
	const [fields, setFields] = useState<Field[]>([]);
	const [behaviour, setBehaviour] = useState<Record<string, Value>>({});
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState<string | null>(null);
	const [error, setError] = useState("");

	useEffect(() => {
		let live = true;
		(async () => {
			try {
				const [schema, current] = await Promise.all([
					api<{ fields: Field[] }>("/v1/instances/behaviour-schema"),
					api<{ behaviour: Record<string, Value> }>(`/v1/instances/${instanceId}/behaviour`),
				]);
				if (!live) return;
				setFields(schema.fields || []);
				setBehaviour(current.behaviour || {});
			} catch (e) {
				if (live) setError(e instanceof Error ? e.message : "Could not load behaviour");
			} finally {
				if (live) setLoaded(true);
			}
		})();
		return () => {
			live = false;
		};
	}, [instanceId]);

	// `null` clears — the only way back to the platform default once a field has been set.
	const save = useCallback(
		async (id: string, value: Value | null) => {
			setSaving(id);
			setError("");
			try {
				const res = await api<{ behaviour: Record<string, Value>; rejected?: string[] }>(
					`/v1/instances/${instanceId}/behaviour`,
					{ method: "PUT", body: JSON.stringify({ behaviour: { [id]: value } }) },
				);
				setBehaviour(res.behaviour || {});
				if (res.rejected?.length) setError(`Not saved: ${res.rejected.join(", ")}`);
			} catch (e) {
				setError(e instanceof Error ? e.message : "Could not save");
			} finally {
				setSaving(null);
			}
		},
		[instanceId],
	);

	const byGroup = useMemo(() => {
		const m = new Map<string, Field[]>();
		for (const f of fields) m.set(f.group, [...(m.get(f.group) ?? []), f]);
		return m;
	}, [fields]);

	const configuredCount = Object.keys(behaviour).length;

	if (!loaded) return <div className="text-sm text-muted">Loading…</div>;

	return (
		<div className="max-w-2xl space-y-6">
			<div>
				<h2 className="text-lg font-semibold">Behaviour</h2>
				<p className="text-sm text-muted mt-1">
					How this agent communicates with you. You can also just tell it in chat — "be less technical", "stop using
					emoji" — and it will change these itself.
				</p>
				{configuredCount === 0 && (
					<p className="text-xs text-muted-soft mt-2">
						Nothing set — the agent is using the platform defaults. Anything you leave alone stays that way.
					</p>
				)}
			</div>

			{error && <div className="text-sm text-red-500">{error}</div>}

			{GROUPS.map((g) => {
				const groupFields = byGroup.get(g.id) ?? [];
				if (!groupFields.length) return null;
				const anySet = groupFields.some((f) => isSet(behaviour, f.id));
				return (
					<section key={g.id} className="border border-border rounded-lg p-4">
						<div className="flex items-start justify-between gap-3 mb-3">
							<div className="min-w-0">
								<h3 className="font-semibold">{g.label}</h3>
								<p className="text-xs text-muted-soft">{g.blurb}</p>
							</div>
							{anySet && (
								<button
									type="button"
									className="text-xs underline text-muted whitespace-nowrap"
									onClick={() => {
										for (const f of groupFields) if (isSet(behaviour, f.id)) void save(f.id, null);
									}}
								>
									Reset group
								</button>
							)}
						</div>
						<div className="space-y-5">
							{groupFields.map((f) => (
								<FieldRow
									key={f.id}
									field={f}
									value={behaviour[f.id]}
									set={isSet(behaviour, f.id)}
									busy={saving === f.id}
									onChange={(v) => void save(f.id, v)}
								/>
							))}
						</div>
					</section>
				);
			})}
		</div>
	);
}

function FieldRow({
	field,
	value,
	set,
	busy,
	onChange,
}: {
	field: Field;
	value: Value | undefined;
	set: boolean;
	busy: boolean;
	onChange: (v: Value | null) => void;
}) {
	// A slider must move while dragging, so it keeps local state and commits on release. Every
	// other control commits immediately.
	const [dragging, setDragging] = useState<number | null>(null);
	const effective = value ?? field.default;

	return (
		<div>
			<div className="flex items-baseline justify-between gap-2">
				<label className="text-sm font-medium">{field.label}</label>
				<div className="flex items-center gap-2 text-xs">
					{busy && <span className="text-muted-soft">saving…</span>}
					{!set && <span className="text-muted-soft">default</span>}
					{set && (
						<button type="button" className="underline text-muted" onClick={() => onChange(null)}>
							reset
						</button>
					)}
				</div>
			</div>
			{field.help && <p className="text-xs text-muted-soft mt-0.5">{field.help}</p>}

			{field.type === "scale" && (
				<div className="mt-2">
					<input
						type="range"
						min={0}
						max={100}
						step={1}
						className="w-full"
						value={dragging ?? (effective as number)}
						onChange={(e) => setDragging(Number(e.target.value))}
						onMouseUp={() => {
							if (dragging !== null) onChange(dragging);
							setDragging(null);
						}}
						onTouchEnd={() => {
							if (dragging !== null) onChange(dragging);
							setDragging(null);
						}}
						onKeyUp={() => {
							if (dragging !== null) onChange(dragging);
							setDragging(null);
						}}
					/>
					{/*
					  The band text, not the number. The user is choosing an instruction — showing "70"
					  would hide what the setting actually does, and the number is only ever a way to
					  point at one of these bands.
					*/}
					<p className="text-xs text-muted mt-1">
						<span className="font-semibold">{bandFor(field, dragging ?? (effective as number))?.label}</span>
						{" — "}
						{bandFor(field, dragging ?? (effective as number))?.prompt}
					</p>
				</div>
			)}

			{field.type === "choice" && (
				<div className="mt-2 space-y-1">
					{field.options?.map((o) => (
						<label key={o.value} className="flex items-start gap-2 text-sm cursor-pointer">
							<input
								type="radio"
								name={`beh-${field.id}`}
								className="mt-1"
								checked={effective === o.value}
								onChange={() => onChange(o.value)}
							/>
							<span className="min-w-0">
								<span className="font-medium">{o.label}</span>
								<span className="block text-xs text-muted-soft">{o.prompt}</span>
							</span>
						</label>
					))}
				</div>
			)}

			{field.type === "toggle" && (
				<label className="flex items-start gap-2 text-sm cursor-pointer mt-2">
					<input type="checkbox" className="mt-1" checked={!!effective} onChange={(e) => onChange(e.target.checked)} />
					<span className="text-xs text-muted-soft">
						{(effective ? field.onPrompt : field.offPrompt) || (effective ? "On" : "Off")}
					</span>
				</label>
			)}

			{field.type === "text" && (
				<input
					type="text"
					className="mt-2 w-full rounded border border-border bg-transparent px-2 py-1 text-sm"
					maxLength={field.maxLength}
					defaultValue={(effective as string) || ""}
					onBlur={(e) => {
						const v = e.target.value.trim();
						if (v === ((value as string) ?? "")) return;
						onChange(v || null);
					}}
				/>
			)}

			{field.type === "number" && (
				<input
					type="number"
					className="mt-2 w-32 rounded border border-border bg-transparent px-2 py-1 text-sm"
					min={field.min}
					max={field.max}
					defaultValue={Number(effective) || 0}
					onBlur={(e) => onChange(Number(e.target.value) || 0)}
				/>
			)}

			{field.type === "list" && (
				<input
					type="text"
					className="mt-2 w-full rounded border border-border bg-transparent px-2 py-1 text-sm"
					placeholder="comma separated"
					defaultValue={Array.isArray(effective) ? (effective as string[]).join(", ") : ""}
					onBlur={(e) => {
						const items = e.target.value
							.split(",")
							.map((x) => x.trim())
							.filter(Boolean);
						onChange(items.length ? items : null);
					}}
				/>
			)}
		</div>
	);
}
