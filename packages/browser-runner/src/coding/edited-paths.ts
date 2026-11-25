import { isAbsolute, relative, resolve } from "node:path";

/**
 * Which files the Engine itself wrote (#1714, a slice of #1670) — the only ownership evidence parking accepts for a SHARED checkout.
 *
 * A structured engine emits a `tool_use` block per call; `Edit`, `Write`, `MultiEdit` and `NotebookEdit` name the file they write. That is
 * what the Engine DID, not what a dirty tree happens to contain, so a path in this set is one this run provably wrote. Nothing else
 * is claimed: a shell `sed -i`, a `git mv`, a raw engine's output and every edit by someone else are NOT here, so parking leaves
 * them exactly where they are (#1547). A gap in this set costs a refused park; a false entry would cost somebody's work.
 */

const WRITERS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** The repo-relative, forward-slash path a write tool call names, or null when it is not a write or lies outside the checkout. */
export function editedPathFromToolUse(name: string, input: unknown, workDir: string): string | null {
	if (!WRITERS.has(name) || !input || typeof input !== "object") return null;
	const raw = (input as Record<string, unknown>).file_path ?? (input as Record<string, unknown>).notebook_path;
	if (typeof raw !== "string" || !raw) return null;
	const rel = relative(resolve(workDir), isAbsolute(raw) ? resolve(raw) : resolve(workDir, raw));
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
	return rel.replaceAll("\\", "/");
}
