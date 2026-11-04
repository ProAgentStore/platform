/** Owner-set job facts, copied byte-identically to browser-runner/src. Never instructions or submit authority. */
export const INSTANCE_PREFERENCES_KEY = "job_application_preferences";
export const INSTANCE_PREFERENCES_MIN_CLI = "0.4.213";
export const INSTANCE_PREFERENCE_FIELDS = ["employment_type", "salary_expectation", "availability", "planned_holidays_next_6_months", "recruitment_adjustments_needed"] as const;
export type InstancePreferenceField = typeof INSTANCE_PREFERENCE_FIELDS[number];
export interface InstancePreferenceFact { field: InstancePreferenceField; answer: string; confirmedAt: string; validUntil?: string }
export interface InstancePreferenceDocument {
	version: 1;
	facts: InstancePreferenceFact[];
	pendingFields?: Array<"salary_super_basis" | "disclosures">;
}
export interface InstancePreferences extends InstancePreferenceDocument {
	source: "user";
	instanceId: string;
	memoryKey: typeof INSTANCE_PREFERENCES_KEY;
	memoryUpdatedAt: string;
	sha256: string;
}
const dateOnly = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().startsWith(value);
/** Reject whole malformed/expired facts; truncation could change an owner's meaning. */
export function parsePreferenceDocument(raw: unknown, now = Date.now(), options: { allowExpired?: boolean } = {}): InstancePreferenceDocument | { error: string } {
	const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
	if (o.version !== 1 || !Array.isArray(o.facts) || o.facts.length > INSTANCE_PREFERENCE_FIELDS.length) return { error: "Expected version 1 and at most five candidate facts." };
	if (Object.keys(o).some(key => !["version", "facts", "pendingFields"].includes(key))) return { error: "Candidate preference document contains unsupported fields." };
	const today = new Date(now).toISOString().slice(0, 10);
	const facts: InstancePreferenceFact[] = [];
	for (const value of o.facts) {
		const f = value && typeof value === "object" ? value as Record<string, unknown> : {};
		if (Object.keys(f).some(key => !["field", "answer", "confirmedAt", "validUntil"].includes(key))) return { error: "Candidate preference fact contains unsupported fields." };
		if (!INSTANCE_PREFERENCE_FIELDS.includes(f.field as InstancePreferenceField) || facts.some(x => x.field === f.field)) return { error: "Candidate preference fields must be recognized and unique." };
		// biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters in single-line factual answers.
		if (typeof f.answer !== "string" || !f.answer.trim() || f.answer.length > 500 || /[\u0000-\u001f\u007f]/.test(f.answer)) return { error: "Each candidate preference needs a complete, single-line answer of at most 500 characters." };
		if (!dateOnly(f.confirmedAt) || f.confirmedAt > today) return { error: "Each candidate preference needs a valid confirmation date that is not in the future." };
		if (f.validUntil !== undefined && (!dateOnly(f.validUntil) || f.validUntil < f.confirmedAt || (!options.allowExpired && f.validUntil < today))) return { error: "A candidate preference has expired or has an invalid validity date; update the instance memory before continuing." };
		if (f.field === "planned_holidays_next_6_months" && !dateOnly(f.validUntil)) return { error: "Planned holidays needs a validity date; it is not a permanent answer." };
		facts.push({ field: f.field as InstancePreferenceField, answer: f.answer, confirmedAt: f.confirmedAt, ...(f.validUntil ? { validUntil: f.validUntil as string } : {}) });
	}
	if (o.pendingFields !== undefined && (!Array.isArray(o.pendingFields) || o.pendingFields.length > 2 || o.pendingFields.some(x => x !== "salary_super_basis" && x !== "disclosures") || new Set(o.pendingFields).size !== o.pendingFields.length)) return { error: "Unanswered candidate preference fields are invalid." };
	return { version: 1, facts, ...(o.pendingFields ? { pendingFields: o.pendingFields as InstancePreferenceDocument["pendingFields"] } : {}) };
}
/** Bind a receipt to this exact local task, even when other instances share its machine. */
export function parseInstancePreferences(raw: unknown, instanceId: string, now = Date.now()): InstancePreferences | { error: string } {
	const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
	if (o.source !== "user" || o.instanceId !== instanceId || o.memoryKey !== INSTANCE_PREFERENCES_KEY || typeof o.memoryUpdatedAt !== "string" || !Number.isFinite(Date.parse(o.memoryUpdatedAt)) || typeof o.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(o.sha256)) return { error: "Candidate preferences are missing their exact owner-instance provenance." };
	const document = parsePreferenceDocument({ version: o.version, facts: o.facts, ...(o.pendingFields !== undefined ? { pendingFields: o.pendingFields } : {}) }, now);
	return "error" in document ? document : { ...document, source: "user", instanceId, memoryKey: INSTANCE_PREFERENCES_KEY, memoryUpdatedAt: o.memoryUpdatedAt, sha256: o.sha256 };
}
