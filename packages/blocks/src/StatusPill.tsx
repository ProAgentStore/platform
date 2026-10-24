export type PillStatus = "indexed" | "pending" | "failed" | "running";

const CLASSES: Record<PillStatus, string> = {
	indexed: "border-success-line bg-success-soft text-success",
	failed: "border-danger-line bg-danger-soft text-danger",
	running: "border-info-line bg-info-soft text-info",
	pending: "border-warning-line bg-warning-soft text-warning",
};

/**
 * A small status pill (#187) — lifted unchanged from the Indexing tab. The caller supplies the
 * words (`label`); the block owns only the status → colour mapping.
 */
export function StatusPill({ status, label }: { status: PillStatus; label: string }) {
	return <span className={`text-2xs px-2 py-0.5 rounded-full border font-semibold ${CLASSES[status]}`}>{label}</span>;
}
