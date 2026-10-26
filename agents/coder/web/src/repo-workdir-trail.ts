// How a repo's stored folder became a path on the machine that ran it (#1379) — the line under the folder that answers "why did it clone THERE".
// Pure, so the sentence is tested and the component only prints it.

const RULE: Record<string, string> = {
	tilde: "~ expanded to that machine's home",
	relative: "taken from that machine's home",
	"foreign-home": "another account's home path moved to that machine's home",
	absolute: "used as written",
};

/** `~/dev/x → /Users/me/dev/x (~ expanded to that machine's home)`, or null when no machine has resolved it yet or it needed no translation. */
export function workdirTrail(r: { workdir?: string; workdirResolved?: string; workdirResolvedVia?: string }): string | null {
	if (!r.workdir || !r.workdirResolved) return null;
	if (r.workdirResolved === r.workdir) return null;
	const rule = r.workdirResolvedVia ? RULE[r.workdirResolvedVia] : undefined;
	return `${r.workdir} → ${r.workdirResolved}${rule ? ` (${rule})` : ""}`;
}
