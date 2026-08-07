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

/**
 * Is this field configured, as opposed to sitting at the platform default?
 *
 * `Object.hasOwn`, not `in` — a field explicitly set to `null` (the API's "clear this") is
 * CONFIGURED, and a prototype-chain hit is not. The long `Object.prototype.hasOwnProperty.call`
 * form said the same thing for the same reason; this is the ES2022 spelling of it.
 */
export function isSet(behaviour: Record<string, Value>, id: string): boolean {
	return Object.hasOwn(behaviour, id);
}

/**
 * Where a field's value came from (#232).
 *
 * `GET` returns the RESOLVED behaviour — the creator's `agents.config.behaviour` merged under the
 * subscriber's override — so "present in the response" is NOT the same as "the subscriber set it".
 * Treating the two as one is what rendered a "reset" link on a creator-supplied default: clicking
 * it cleared an override that was never there, the resolved value came straight back, and the row
 * did not change. A control that visibly does nothing.
 *
 * - `default`  — nobody set it; the platform's own heuristics apply.
 * - `template` — the CREATOR shipped it. The subscriber has nothing to reset, so no reset link.
 * - `override` — the subscriber changed it. Reset clears back to the creator's default (which may
 *                be a value, not nothing), and the label changes with it.
 */
export type FieldState = "default" | "template" | "override";

/** Ordered deep-equality over the four behaviour value shapes (number/string/boolean/string[]). */
export function sameValue(a: Value | undefined, b: Value | undefined): boolean {
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b)) return false;
		return a.length === b.length && a.every((x, i) => x === b[i]);
	}
	return a === b;
}

export function fieldState(
	behaviour: Record<string, Value>,
	templateDefault: Record<string, Value>,
	id: string,
): FieldState {
	if (!isSet(behaviour, id)) return "default";
	// Resolved value identical to what the creator shipped ⇒ the subscriber has changed nothing,
	// whether or not an override row exists. Offering "reset" for a value that would come back
	// unchanged is the inert control this distinction removes.
	if (isSet(templateDefault, id) && sameValue(behaviour[id], templateDefault[id])) return "template";
	return "override";
}

export default function BehaviourTab({ instanceId }: { instanceId: string }) {
	const [fields, setFields] = useState<Field[]>([]);
	const [behaviour, setBehaviour] = useState<Record<string, Value>>({});
	// What the CREATOR shipped, kept beside the resolved values so a row can say which of the two
	// it is showing. Without it every creator default looked like a subscriber override (#232).
	const [templateDefault, setTemplateDefault] = useState<Record<string, Value>>({});
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState<string[]>([]);
	const [error, setError] = useState("");

	useEffect(() => {
		let live = true;
		(async () => {
			try {
				const [schema, current] = await Promise.all([
					api<{ fields: Field[] }>("/v1/instances/behaviour-schema"),
					api<{ behaviour: Record<string, Value>; templateDefault?: Record<string, Value> }>(
						`/v1/instances/${instanceId}/behaviour`,
					),
				]);
				if (!live) return;
				setFields(schema.fields || []);
				setBehaviour(current.behaviour || {});
				setTemplateDefault(current.templateDefault || {});
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

	/**
	 * Save a PATCH — one request, however many fields.
	 *
	 * Deliberately not one request per field. The server read-modify-writes the whole
	 * `agent_instances.config` blob, so N concurrent PUTs each read the same pre-patch config and
	 * the last write wins: "Reset group" fired five of them and cleared exactly one field, at
	 * random. `null` clears a field — the only way back to the platform default once one is set.
	 */
	const save = useCallback(
		async (patch: Record<string, Value | null>) => {
			const ids = Object.keys(patch);
			if (!ids.length) return;
			setSaving(ids);
			setError("");
			try {
				const res = await api<{ behaviour: Record<string, Value>; templateDefault?: Record<string, Value>; rejected?: string[] }>(
					`/v1/instances/${instanceId}/behaviour`,
					{ method: "PUT", body: JSON.stringify({ behaviour: patch }) },
				);
				setBehaviour(res.behaviour || {});
				// The response replaces the resolved state, so it must carry the creator's default
				// with it — otherwise the first save after load would compare new values against a
				// stale template and re-label every row.
				if (res.templateDefault) setTemplateDefault(res.templateDefault);
				if (res.rejected?.length) setError(`Not saved: ${res.rejected.join(", ")}`);
			} catch (e) {
				setError(e instanceof Error ? e.message : "Could not save");
			} finally {
				setSaving([]);
			}
		},
		[instanceId],
	);

	const byGroup = useMemo(() => {
		const m = new Map<string, Field[]>();
		for (const f of fields) m.set(f.group, [...(m.get(f.group) ?? []), f]);
		return m;
	}, [fields]);

	// Only the SUBSCRIBER's own changes count as "configured". A creator default is part of the
	// agent, not something the user did, and counting it made the page claim settings the user
	// could not find anywhere they had touched.
	const stateOf = useCallback((id: string) => fieldState(behaviour, templateDefault, id), [behaviour, templateDefault]);
	const overrideCount = fields.filter((f) => stateOf(f.id) === "override").length;
	const templateCount = fields.filter((f) => stateOf(f.id) === "template").length;

	if (!loaded) return <div className="text-sm text-muted">Loading…</div>;

	return (
		<div className="max-w-2xl space-y-6">
			<div>
				<h2 className="text-lg font-semibold">Behaviour</h2>
				<p className="text-sm text-muted mt-1">
					How this agent communicates with you. You can also just tell it in chat — "be less technical", "stop using
					emoji" — and it will change these itself.
				</p>
				{overrideCount === 0 && (
					<p className="text-xs text-muted-soft mt-2">
						{templateCount > 0
							? "You haven't changed anything — this agent ships with its own defaults, marked below. Anything you leave alone stays that way."
							: "Nothing set — the agent is using the platform defaults. Anything you leave alone stays that way."}
					</p>
				)}
			</div>

			{error && <div className="text-sm text-red-500">{error}</div>}

			{GROUPS.map((g) => {
				const groupFields = byGroup.get(g.id) ?? [];
				if (!groupFields.length) return null;
				// "Reset group" clears OVERRIDES only — a group whose values all come from the creator
				// has nothing to reset, and offering it there was the same inert control one level up.
				const overrides = groupFields.filter((f) => stateOf(f.id) === "override");
				return (
					<section key={g.id} className="border border-line rounded-lg p-4">
						<div className="flex items-start justify-between gap-3 mb-3">
							<div className="min-w-0">
								<h3 className="font-semibold">{g.label}</h3>
								<p className="text-xs text-muted-soft">{g.blurb}</p>
							</div>
							{overrides.length > 0 && (
								<button
									type="button"
									className="text-xs underline text-muted whitespace-nowrap"
									onClick={() => void save(Object.fromEntries(overrides.map((f) => [f.id, null])))}
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
									state={stateOf(f.id)}
									busy={saving.includes(f.id)}
									onChange={(v) => void save({ [f.id]: v })}
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
	state,
	busy,
	onChange,
}: {
	field: Field;
	value: Value | undefined;
	state: FieldState;
	busy: boolean;
	onChange: (v: Value | null) => void;
}) {
	// A slider must move while dragging, so it keeps local state and commits on release. Every
	// other control commits immediately.
	const [dragging, setDragging] = useState<number | null>(null);
	const effective = value ?? field.default;
	/**
	 * Remount key for the uncontrolled inputs below.
	 *
	 * They use defaultValue so typing isn't fought by a re-render, but that also means React never
	 * updates them from props — click "reset" on a text field and the box still showed the old
	 * text, looking like the reset had failed. `value` only changes when a SAVE lands, so this
	 * remounts then and never mid-keystroke.
	 */
	const inputKey = `${field.id}:${Array.isArray(value) ? value.join(",") : String(value ?? "")}`;

	const commit = () => {
		if (dragging !== null) onChange(dragging);
		setDragging(null);
	};

	/**
	 * The field's label sits in a header row with the state chip and the reset button, so it was
	 * never associated with the control below it — every slider, text box and number box on this
	 * tab announced as an unnamed control, and 19 unnamed sliders are indistinguishable. Pairing
	 * `htmlFor`/`id` also makes the label click-to-focus.
	 *
	 * `toggle` is the exception: its input is already wrapped in its own `<label>` whose text is
	 * the on/off prompt, so pointing this one at it too would name it twice.
	 */
	const controlId = `behaviour-${field.id}`;

	return (
		<div>
			<div className="flex items-baseline justify-between gap-2">
				<label className="text-sm font-medium" htmlFor={field.type === "toggle" ? undefined : controlId}>{field.label}</label>
				<div className="flex items-center gap-2 text-xs">
					{busy && <span className="text-muted-soft">saving…</span>}
					{state === "default" && <span className="text-muted-soft">default</span>}
					{/* The creator set it, not you. There is no override to clear, so no control that
					    would appear to do something and then not. */}
					{state === "template" && <span className="text-muted-soft" title="Set by the agent's creator">agent default</span>}
					{state === "override" && (
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
						id={controlId}
						type="range"
						min={0}
						max={100}
						step={1}
						className="w-full"
						value={dragging ?? (effective as number)}
						onChange={(e) => setDragging(Number(e.target.value))}
						onPointerUp={commit}
						onKeyUp={commit}
						// Releasing the mouse OUTSIDE the input never fired pointerup on it, so the
						// slider showed a value that was never saved and stayed stuck at it.
						onBlur={commit}
						onPointerLeave={(e) => {
							if (e.buttons === 0) commit();
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
					key={inputKey}
					id={controlId}
					type="text"
					className="mt-2 w-full rounded border border-line bg-transparent px-2 py-1 text-sm"
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
					key={inputKey}
					id={controlId}
					type="number"
					className="mt-2 w-32 rounded border border-line bg-transparent px-2 py-1 text-sm"
					min={field.min}
					max={field.max}
					defaultValue={Number(effective) || 0}
					onBlur={(e) => onChange(Number(e.target.value) || 0)}
				/>
			)}

			{field.type === "list" && (
				<input
					key={inputKey}
					id={controlId}
					type="text"
					className="mt-2 w-full rounded border border-line bg-transparent px-2 py-1 text-sm"
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
