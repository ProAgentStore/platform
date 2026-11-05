import { browserEvidenceText } from "./browser-evidence-text.js";

const KINDS = ["request_deadline", "transport_failure", "page_operation_failure", "browser_process_lost", "quarantined"] as const;
const PHASES = ["native_request", "native_response", "recovery"] as const;
const EXECUTIONS = ["pending", "settled", "unknown", "not_dispatched"] as const;
export interface StoredBrowserToolDiagnostic {
	kind: (typeof KINDS)[number];
	phase: (typeof PHASES)[number];
	tool: string;
	execution: (typeof EXECUTIONS)[number];
	recoverable: boolean;
	message: string;
	originalError?: string;
	elapsedMs: number;
	machine: { load1: number | null; loadPerCpu: number | null; cpus: number; freeMemoryBytes: number; totalMemoryBytes: number };
}

const object = (raw: unknown): Record<string, unknown> | null => raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
const member = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === "string" && values.includes(value as T);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const load = (value: unknown): value is number | null => value === null || typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Preserve typed failure evidence without persisting arbitrary nested runner output. */
export function sanitizeBrowserToolDiagnostic(raw: unknown): StoredBrowserToolDiagnostic | undefined {
	const d = object(raw), machine = object(d?.machine);
	if (!d || !machine || !member(KINDS, d.kind) || !member(PHASES, d.phase) || !member(EXECUTIONS, d.execution)
		|| typeof d.tool !== "string" || !d.tool || d.tool.length > 100 || typeof d.recoverable !== "boolean"
		|| typeof d.message !== "string" || !integer(d.elapsedMs) || !integer(machine.cpus) || machine.cpus < 1
		|| !integer(machine.freeMemoryBytes) || !integer(machine.totalMemoryBytes) || !load(machine.load1) || !load(machine.loadPerCpu)) return undefined;
	const originalError = browserEvidenceText(d.originalError, 2000);
	return {
		kind: d.kind, phase: d.phase, tool: browserEvidenceText(d.tool, 100)!, execution: d.execution, recoverable: d.recoverable,
		message: browserEvidenceText(d.message, 2000)!, ...(originalError === undefined ? {} : { originalError }), elapsedMs: d.elapsedMs,
		machine: { load1: machine.load1, loadPerCpu: machine.loadPerCpu, cpus: machine.cpus, freeMemoryBytes: machine.freeMemoryBytes, totalMemoryBytes: machine.totalMemoryBytes },
	};
}
