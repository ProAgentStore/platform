/** What a machine can do (#1312), as `GET /v1/terminals/machines/:id/capabilities?history=1` reports it, and how the card words it. */

export interface BrowserVerdict {
	supported: boolean;
	probed: boolean;
	reason?: string;
}
export interface CapabilitySummary {
	os: string;
	arch: string;
	cpuCount: number | null;
	memoryGb: number | null;
	diskGb: number | null;
	nodeVersion: string | null;
	playwrightVersion: string | null;
	browsers: { chromium: BrowserVerdict; firefox: BrowserVerdict; webkit: BrowserVerdict };
	ios: boolean;
	android: boolean;
	docker: boolean;
	inventoryCount: number;
	reportedAt: string;
}
export interface MachineCapabilitiesResponse {
	machineId: string;
	reported: boolean;
	message?: string;
	summary?: CapabilitySummary;
	capabilities?: { inventory: Array<{ name: string; version: string }> };
	history?: Array<{ changedAt: string; hash: string; changes: string[] }>;
}

/** One engine as a sentence: it launched, it cannot (and why), or it was never tried. */
export function browserLine(name: string, v: BrowserVerdict): { text: string; tone: "ok" | "bad" | "muted" } {
	if (v.supported) return { text: `${name}: launches`, tone: "ok" };
	if (v.probed) return { text: `${name}: does not launch${v.reason ? ` — ${v.reason}` : ""}`, tone: "bad" };
	// Not probed: the platform's OS rule table may still know it cannot work here.
	return v.reason?.includes("is not supported") ? { text: `${name}: unsupported — ${v.reason}`, tone: "bad" } : { text: `${name}: not probed`, tone: "muted" };
}

export function supportLine(label: string, on: boolean): string {
	return `${label}: ${on ? "available" : "not available"}`;
}

export function resourceLine(s: Pick<CapabilitySummary, "cpuCount" | "memoryGb" | "diskGb">): string {
	const parts = [s.cpuCount != null ? `${s.cpuCount} cores` : null, s.memoryGb != null ? `${s.memoryGb} GB memory` : null, s.diskGb != null ? `${s.diskGb} GB disk` : null].filter((p): p is string => !!p);
	return parts.length ? parts.join(" · ") : "not reported";
}
