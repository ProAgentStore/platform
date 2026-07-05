import type { Env } from "../types.js";

/** A profile value map keyed by the camelCase field key. */
export type Profile = Record<string, string | undefined>;

export interface ProfileFieldDef {
	key: string; // camelCase API key
	/** D1 column; omitted for fields stored in the `custom` JSON (no migration). */
	column?: string;
	label: string; // human label (console + prompts)
	/** Private fields are gated behind per-instance consent (Phase 2). */
	private: boolean;
	/** Grouping for the UI: "identity" (candidate info) or "preferences" (what they want). */
	group?: "identity" | "preferences";
}

/**
 * The standard candidate-profile schema the platform offers to agents. Column
 * order matches the INSERT in upsertProfile; column-less fields live in `custom`.
 */
export const PROFILE_FIELDS: ProfileFieldDef[] = [
	{ key: "firstName", column: "first_name", label: "First name", private: false, group: "identity" },
	{ key: "lastName", column: "last_name", label: "Last name", private: false, group: "identity" },
	{ key: "email", column: "email", label: "Email", private: false, group: "identity" },
	{ key: "phone", column: "phone", label: "Phone", private: true, group: "identity" },
	{ key: "city", column: "city", label: "City", private: true, group: "identity" },
	{ key: "state", column: "state", label: "State/Region", private: true, group: "identity" },
	{ key: "country", column: "country", label: "Country", private: false, group: "identity" },
	{ key: "postalCode", column: "postal_code", label: "Postal code", private: true, group: "identity" },
	{ key: "linkedin", column: "linkedin", label: "LinkedIn", private: false, group: "identity" },
	{ key: "website", column: "website", label: "Website/Portfolio", private: false, group: "identity" },
	{ key: "workAuthorization", column: "work_authorization", label: "Work authorization", private: false, group: "identity" },
	{ key: "salaryExpectation", column: "salary_expectation", label: "Salary expectation", private: true, group: "identity" },
	// Job preferences (what you want) — stored in `custom`, no migration. They guide
	// the agent's answers (location / work-type / relocation) and are the basis for
	// future job discovery.
	{ key: "targetRoles", label: "Target roles / titles", private: false, group: "preferences" },
	{ key: "targetLocations", label: "Target locations", private: false, group: "preferences" },
	{ key: "workType", label: "Work type (Remote / Hybrid / Onsite)", private: false, group: "preferences" },
	{ key: "openToRelocation", label: "Open to relocation? (Yes / No)", private: false, group: "preferences" },
];

const COL_BY_KEY = new Map(PROFILE_FIELDS.filter((f) => f.column).map((f) => [f.key, f.column as string]));

/** The user's structured profile as a flat camelCase map (empty if none yet). */
export async function getProfile(env: Env, userId: string): Promise<Profile> {
	const row = await env.DB.prepare("SELECT * FROM user_profile WHERE user_id = ?1").bind(userId).first<Record<string, unknown>>();
	const p: Profile = {};
	if (!row) return p;
	for (const f of PROFILE_FIELDS) {
		if (!f.column) continue; // column-less fields come from `custom` below
		const v = row[f.column];
		if (v != null && String(v) !== "") p[f.key] = String(v);
	}
	if (typeof row.custom === "string" && row.custom) {
		try {
			for (const [k, v] of Object.entries(JSON.parse(row.custom) as Record<string, unknown>)) {
				if (v != null && String(v) !== "") p[k] = String(v);
			}
		} catch {
			/* ignore bad custom JSON */
		}
	}
	return p;
}

/** Merge `fields` into the user's profile (a value of null/"" clears a field). */
export async function upsertProfile(env: Env, userId: string, fields: Profile): Promise<void> {
	const merged: Profile = { ...(await getProfile(env, userId)) };
	for (const [k, v] of Object.entries(fields)) {
		if (v === undefined) continue;
		if (v === null || v === "") delete merged[k];
		else merged[k] = String(v);
	}
	const col = (key: string) => merged[key] ?? null;
	const custom: Record<string, string> = {};
	for (const [k, v] of Object.entries(merged)) {
		if (!COL_BY_KEY.has(k) && v != null) custom[k] = v;
	}
	await env.DB.prepare(
		`INSERT INTO user_profile (user_id, first_name, last_name, email, phone, city, state, country, postal_code, linkedin, website, work_authorization, salary_expectation, custom, updated_at)
		 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14, datetime('now'))
		 ON CONFLICT(user_id) DO UPDATE SET first_name=excluded.first_name, last_name=excluded.last_name, email=excluded.email, phone=excluded.phone, city=excluded.city, state=excluded.state, country=excluded.country, postal_code=excluded.postal_code, linkedin=excluded.linkedin, website=excluded.website, work_authorization=excluded.work_authorization, salary_expectation=excluded.salary_expectation, custom=excluded.custom, updated_at=datetime('now')`,
	)
		.bind(
			userId,
			col("firstName"), col("lastName"), col("email"), col("phone"), col("city"), col("state"),
			col("country"), col("postalCode"), col("linkedin"), col("website"), col("workAuthorization"),
			col("salaryExpectation"), Object.keys(custom).length ? JSON.stringify(custom) : null,
		)
		.run();
}

/** Set a single profile field (used by the apply agent's ask-and-hold). */
export async function setProfileField(env: Env, userId: string, key: string, value: string): Promise<void> {
	await upsertProfile(env, userId, { [key]: value });
}

/**
 * Persist an ask-and-hold answer WITHOUT corrupting canonical PII. If the field maps
 * to a standard identity key (email, phone, salary, city…) that the user has ALREADY
 * filled, a per-application answer must not overwrite it for all future runs — stash
 * it under a custom key instead (still reused via {@link profileCustomAnswers}). Only
 * an empty standard field, or a genuinely non-standard field, is written directly.
 */
export async function saveAskAndHoldAnswer(env: Env, userId: string, field: string, value: string): Promise<void> {
	const key = guessProfileKey(field);
	if (STD_PROFILE_KEYS.has(key)) {
		const existing = await getProfile(env, userId);
		if (typeof existing[key] === "string" && (existing[key] as string).trim()) {
			const customKey = field.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "note";
			await upsertProfile(env, userId, { [customKey]: value });
			return;
		}
	}
	await upsertProfile(env, userId, { [key]: value });
}

/** The user's job-search preferences (what they want), for the apply prompt. */
export function profileToPreferences(p: Profile): { targetRoles?: string; targetLocations?: string; workType?: string; openToRelocation?: string } {
	return { targetRoles: p.targetRoles, targetLocations: p.targetLocations, workType: p.workType, openToRelocation: p.openToRelocation };
}

const STD_PROFILE_KEYS = new Set(PROFILE_FIELDS.map((f) => f.key));

/**
 * Custom answers the agent previously asked the user for via a needs_input ticket
 * (saved to the profile's `custom` JSON under a sanitized key like
 * `australian_working_rights`). These are NOT standard candidate fields, so they'd
 * otherwise be invisible to a later run — surface them as `providedAnswers` so a
 * saved ticket answer ("australian working rights: Australian citizen") is REUSED
 * next time instead of the agent re-asking or falling back to the wrong field
 * (e.g. a US-specific `workAuthorization` value on an Australian question).
 */
export function profileCustomAnswers(p: Profile): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(p)) {
		if (STD_PROFILE_KEYS.has(k) || typeof v !== "string" || !v.trim()) continue;
		out[k.replace(/_/g, " ")] = v;
	}
	return out;
}

/**
 * Map a freeform field label the agent asked about ("phone", "salary
 * expectation", "LinkedIn URL") to a standard profile key, so an ask-and-hold
 * answer is saved to the right field. Returns a sanitized custom key if unknown.
 */
export function guessProfileKey(field: string): string {
	const f = field.toLowerCase();
	if (/phone|mobile|tel/.test(f)) return "phone";
	if (/salary|compensation|pay|rate/.test(f)) return "salaryExpectation";
	if (/linkedin/.test(f)) return "linkedin";
	if (/portfolio|website|url|site/.test(f)) return "website";
	if (/work auth|authoriz|right to work|visa|sponsor/.test(f)) return "workAuthorization";
	if (/postal|zip/.test(f)) return "postalCode";
	if (/city/.test(f)) return "city";
	if (/state|province|region/.test(f)) return "state";
	if (/country/.test(f)) return "country";
	if (/email/.test(f)) return "email";
	if (/first name/.test(f)) return "firstName";
	if (/last name|surname/.test(f)) return "lastName";
	return f.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "note";
}

/** Convenience: the candidate shape the apply flow needs, derived from the profile. */
export function profileToCandidate(p: Profile): {
	fullName: string;
	email: string;
	phone?: string;
	location?: string;
	linkedin?: string;
	portfolio?: string;
	workAuthorization?: string;
	salaryExpectation?: string;
} {
	const fullName = [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
	const location = [p.city, p.state, p.country].filter(Boolean).join(", ");
	return {
		fullName,
		email: p.email ?? "",
		phone: p.phone,
		location: location || undefined,
		linkedin: p.linkedin,
		portfolio: p.website,
		workAuthorization: p.workAuthorization,
		salaryExpectation: p.salaryExpectation,
	};
}
