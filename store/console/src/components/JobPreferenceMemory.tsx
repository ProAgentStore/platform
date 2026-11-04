import { useState } from "react";
import { JOB_PREFERENCE_LABELS, PENDING_PREFERENCE_LABELS, type InstancePreferenceDocument, type InstancePreferenceFact } from "../lib/jobPreferenceMemory";

export function JobPreferenceMemoryView({ document }: { document: InstancePreferenceDocument }) {
	return <div className="mt-3 text-sm">
		<dl className="flex flex-col gap-3">
			{document.facts.map(fact => <div key={fact.field}>
				<dt className="font-semibold">{JOB_PREFERENCE_LABELS[fact.field]}</dt>
				<dd className="m-0 whitespace-pre-wrap break-words">{fact.answer}</dd>
				<dd className="m-0 text-xs text-muted">Confirmed {fact.confirmedAt}{fact.validUntil ? ` · Valid through ${fact.validUntil}` : ""}</dd>
				{expired(fact) && <dd className="m-0 text-xs text-warning">Expired — confirm this answer again before using it.</dd>}
			</div>)}
		</dl>
		{document.facts.length === 0 && <p>No confirmed answers saved.</p>}
		<PendingPreferences document={document} />
	</div>;
}

export function JobPreferenceMemoryEditor({ document, onChange }: { document: InstancePreferenceDocument; onChange: (content: string) => void }) {
	const [draft, setDraft] = useState(document);
	const change = (field: InstancePreferenceFact["field"], patch: Partial<InstancePreferenceFact>) => {
		const next = { ...draft, facts: draft.facts.map(fact => fact.field === field ? { ...fact, ...patch } : fact) };
		setDraft(next);
		onChange(JSON.stringify(next, null, 2));
	};
	return <div className="flex flex-col gap-4">
		{draft.facts.map(fact => <fieldset key={fact.field} className="min-w-0">
			<legend className="font-semibold text-sm mb-1">{JOB_PREFERENCE_LABELS[fact.field]}</legend>
			{expired(fact) && <p className="text-xs text-warning mb-2">Expired — confirm the answer and update its dates.</p>}
			<label className="flex flex-col gap-1 text-sm">
				<span>Answer</span>
				<input aria-label={`${JOB_PREFERENCE_LABELS[fact.field]} answer`} value={fact.answer} maxLength={500} onChange={e => change(fact.field, { answer: e.target.value })} className="w-full min-w-0 bg-paper border border-line rounded-lg px-3 py-2 text-sm" />
			</label>
			<div className="grid gap-2 mt-2 sm:grid-cols-2">
				<label className="flex flex-col gap-1 text-xs"><span>Confirmed on</span><input type="date" aria-label={`${JOB_PREFERENCE_LABELS[fact.field]} confirmed on`} value={fact.confirmedAt} onChange={e => change(fact.field, { confirmedAt: e.target.value })} className="w-full min-w-0" /></label>
				{fact.validUntil !== undefined && <label className="flex flex-col gap-1 text-xs"><span>Valid through</span><input type="date" aria-label={`${JOB_PREFERENCE_LABELS[fact.field]} valid through`} value={fact.validUntil} onChange={e => change(fact.field, { validUntil: e.target.value })} className="w-full min-w-0" /></label>}
			</div>
		</fieldset>)}
		<PendingPreferences document={draft} />
	</div>;
}

function expired(fact: InstancePreferenceFact): boolean {
	return !!fact.validUntil && fact.validUntil < new Date().toISOString().slice(0, 10);
}

function PendingPreferences({ document }: { document: InstancePreferenceDocument }) {
	if (!document.pendingFields?.length) return null;
	return <div className="mt-3 text-sm"><p className="font-semibold">Still needs your answer</p><ul className="list-disc pl-5">{document.pendingFields.map(field => <li key={field}>{PENDING_PREFERENCE_LABELS[field]}</li>)}</ul></div>;
}
