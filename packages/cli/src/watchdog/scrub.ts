// Paths and token-shaped strings removed from anything the watchdog sends: a log tail or an error is for a human reading what happened.
const PATHY = /(?:[A-Za-z]:\\[^\s'"]*|(?:~|\.{0,2})\/[^\s'"]+)/g;
const TOKENY = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*|[A-Fa-f0-9]{40,})\b/g;
export function scrubText(text: string, max: number): string {
	const s = String(text ?? "").replace(TOKENY, "<secret>").replace(PATHY, "<path>").trim();
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
