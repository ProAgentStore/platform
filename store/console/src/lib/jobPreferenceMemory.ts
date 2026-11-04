import { parsePreferenceDocument, type InstancePreferenceDocument, type InstancePreferenceField } from "../../../../workers/api/src/lib/instance-preferences-contract";

export { INSTANCE_PREFERENCES_KEY } from "../../../../workers/api/src/lib/instance-preferences-contract";
export type { InstancePreferenceDocument, InstancePreferenceFact } from "../../../../workers/api/src/lib/instance-preferences-contract";

export const JOB_PREFERENCE_LABELS: Record<InstancePreferenceField, string> = {
	employment_type: "Employment type",
	salary_expectation: "Salary expectation",
	availability: "Availability",
	planned_holidays_next_6_months: "Planned holidays in the next six months",
	recruitment_adjustments_needed: "Recruitment adjustments needed",
};

export const PENDING_PREFERENCE_LABELS = { salary_super_basis: "Whether salary includes superannuation", disclosures: "Application disclosures" };

/** The editor uses the same bounded validator as execution; invalid records remain visible. */
export function readJobPreferenceMemory(content: string, options: { now?: number; allowExpired?: boolean } = {}): InstancePreferenceDocument | { error: string } {
	if (new TextEncoder().encode(content).length > 8192) return { error: "Job preferences exceed the supported size. Review the original memory below." };
	try { return parsePreferenceDocument(JSON.parse(content), options.now ?? Date.now(), { allowExpired: options.allowExpired }); }
	catch { return { error: "These job preferences are not in the supported format. Review the original memory below." }; }
}
