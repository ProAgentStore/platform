/**
 * How a tailoring run launches its CLI, what it asks it for, and how the answer is checked (#956).
 *
 * The CLI gets NO tools. Claude Code runs with `--tools ""` and an empty, strict MCP config; Codex
 * runs `--sandbox read-only` with user config and web search off, in an empty scratch folder. The
 * owner's sources are read by the RUNTIME and handed over in the prompt, and the CLI answers with
 * one JSON object; the runtime — not the CLI — writes the files. So the CLI cannot write anywhere,
 * and every write is confined to the run's own folder by code the runner controls.
 *
 * Subscription-only: both modes remove the per-token provider keys from the inherited environment
 * (an empty overlay value means remove — `mergeEnv`), and `machine` also removes the Claude
 * subscription token so the CLI's own stored login is what runs. The env is then READ BACK
 * (`resolveEngineAuth`) and a run whose engine would still see an API key is refused, not started.
 *
 * Truthfulness is checked, not requested: the CLI must cite, for every claim, a verbatim quote
 * from a named source, and every quote is looked up in that source. Years, emails and phone
 * numbers in the generated text must also appear in the sources. Anything that does not check
 * out pauses the run with `needs_human` — no file is written from an unverified draft.
 */
import { mergeEnv } from "../coding/engine-env.js";
import { resolveEngineAuth } from "../coding/engine-auth.js";
import { finalText as finalTextFromEngine, missingLogin } from "../local-browser/engine.js";
import type { LocalArtifactAuthMode, LocalArtifactEngine, LocalArtifactEngineAuth, LocalArtifactLead, LocalArtifactSourceRole } from "./contract.js";

export { missingLogin };

const PROVIDER_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
const SUBSCRIPTION_TOKEN = "CLAUDE_CODE_OAUTH_TOKEN";

/** The engine's environment: the machine's, never with a provider API key. */
export function artifactEngineEnv(authMode: LocalArtifactAuthMode, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const overlay: Record<string, string> = {};
	for (const k of PROVIDER_KEYS) overlay[k] = "";
	if (authMode === "machine") overlay[SUBSCRIPTION_TOKEN] = "";
	return mergeEnv(base, overlay);
}

export function observedArtifactAuth(engine: LocalArtifactEngine, env: NodeJS.ProcessEnv): LocalArtifactEngineAuth {
	return resolveEngineAuth(engine, env as Record<string, string | undefined>);
}

export function buildArtifactEngineSpec(input: { engine: LocalArtifactEngine; authMode: LocalArtifactAuthMode; prompt: string; baseEnv?: NodeJS.ProcessEnv }): {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
} {
	const env = artifactEngineEnv(input.authMode, input.baseEnv);
	if (input.engine === "claude") {
		return {
			command: "claude",
			args: ["-p", input.prompt, "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config", "--permission-mode", "dontAsk"],
			env,
		};
	}
	return {
		command: "codex",
		args: ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "--ignore-user-config", "-c", 'web_search="disabled"', "-c", "tools.web_search=false", input.prompt],
		env,
	};
}

export interface SourceText {
	role: LocalArtifactSourceRole;
	text: string;
}

/** The brief. The rules are stated, but the checks in `checkDraft` are what enforce them. */
export function tailorPrompt(lead: LocalArtifactLead, sources: readonly SourceText[]): string {
	const l = lead.lead;
	const job = [
		`Title: ${l.title}`,
		l.company ? `Company: ${l.company}` : "",
		l.location ? `Location: ${l.location}` : "",
		lead.leadUrl ? `URL: ${lead.leadUrl}` : "",
		l.match_rationale ? `Why it matched: ${l.match_rationale}` : "",
	]
		.filter(Boolean)
		.join("\n");
	const blocks = sources.map((s) => `<source role="${s.role}">\n${s.text}\n</source>`).join("\n\n");
	return [
		"You tailor a job application for the owner of this machine: a résumé variant and a cover letter for ONE job.",
		"You have no tools. Everything you may use is below. Answer with ONE JSON object and nothing else.",
		"",
		"<job>",
		job,
		"</job>",
		"",
		blocks,
		"",
		"Rules — these are checked mechanically, and a draft that breaks one is discarded:",
		"- Use ONLY facts stated in the sources. Never invent or embellish an employer, title, qualification, date, skill, metric, work authorisation, salary expectation or answer.",
		'- For EVERY factual claim about the owner in either document, add an entry to "claims" with the claim, the source role it comes from, and a short VERBATIM quote copied exactly from that source.',
		"- Every year, email address and phone number you write must appear in the sources.",
		"- Reword and reorder to fit the job; do not add what the sources do not say. Leave out what does not fit.",
		'- If something the application needs is missing or uncertain, do not guess: answer {"status":"needs_human","questions":["…"]} instead.',
		"",
		"Answer shape when you can do it:",
		'{"status":"ready","resume_markdown":"…","cover_letter_markdown":"…","claims":[{"text":"…","source":"resume","quote":"…"}]}',
	].join("\n");
}

export type DraftValidationError = "no_json_object" | "invalid_json" | "not_draft_object" | "incomplete_draft" | "unverified_claim";
export type ParsedDraft = { draft: Record<string, unknown> | null; validationError?: DraftValidationError; parseAttempts: string[] };

/** JSON objects from fenced blocks or prose, while respecting braces inside JSON strings. */
function jsonCandidates(text: string): Array<{ source: string; text: string }> {
	const candidates: Array<{ source: string; text: string }> = [];
	for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push({ source: "fenced_json", text: match[1].trim() });
	for (let start = 0; start < text.length; start++) {
		if (text[start] !== "{") continue;
		let quoted = false, escaped = false, depth = 0;
		for (let end = start; end < text.length; end++) {
			const ch = text[end];
			if (quoted) {
				if (escaped) escaped = false;
				else if (ch === "\\") escaped = true;
				else if (ch === '"') quoted = false;
				continue;
			}
			if (ch === '"') quoted = true;
			else if (ch === "{") depth++;
			else if (ch === "}" && --depth === 0) { candidates.push({ source: "balanced_object", text: text.slice(start, end + 1) }); break; }
		}
	}
	return candidates;
}

/** Prefer the structured closing message, but tolerate a CLI that printed a JSON object directly.
 * Non-JSON output must stay empty so login and process-failure handling remains fail-closed. */
export function finalText(engine: LocalArtifactEngine, lines: readonly string[]): string {
	const structured = finalTextFromEngine(engine, lines);
	if (structured) return structured;
	const raw = lines.join("\n");
	return jsonCandidates(raw).length ? raw : "";
}

/** The CLI's answer, with a closed diagnostic instead of a generic parsing collapse. */
export function parseDraft(text: string): ParsedDraft {
	const candidates = jsonCandidates(text);
	if (!candidates.length) return { draft: null, validationError: "no_json_object", parseAttempts: ["fenced_json", "balanced_object"] };
	let invalid = false;
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate.text);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "status" in parsed) return { draft: parsed as Record<string, unknown>, parseAttempts: [candidate.source] };
		} catch { invalid = true; }
	}
	return { draft: null, validationError: invalid ? "invalid_json" : "not_draft_object", parseAttempts: [...new Set(candidates.map((c) => c.source))] };
}

/** Case, whitespace, quote-style and dash-style insensitive — so a faithful quote is never failed on typography. */
export function normalize(s: string): string {
	return s
		.toLowerCase()
		.replace(/[‘’]/g, "'")
		.replace(/[“”]/g, '"')
		.replace(/[–—]/g, "-")
		.replace(/\s+/g, " ")
		.trim();
}

const YEAR = /\b(?:19|20)\d{2}\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Nine digits or more, so a year range ("2019 - 2021") is not read as a phone number. */
const PHONE = /\+?\d[\d\s().-]{7,}\d/g;
const digits = (s: string) => s.replace(/\D/g, "");

export type DraftCheck =
	| { ok: true; resume: string; coverLetter: string; claims: number }
	| { ok: false; reason: "missing_information" | "uncertain_claim" | "invalid_cli_output"; questions: string[]; claims: number; unmatched: number; validationError: DraftValidationError; parseAttempts: string[] };

/**
 * Check the CLI's draft against the sources. Questions name WHAT to confirm, bounded, and are
 * returned only to the owner's own record — never to a trace.
 */
export function checkDraft(parsed: ParsedDraft, sources: readonly SourceText[]): DraftCheck {
	const draft = parsed.draft;
	if (!draft) return { ok: false, reason: "invalid_cli_output", questions: [`The CLI did not return a readable application JSON object (${parsed.validationError ?? "unknown"}). Retry tailoring after checking the CLI output format.`], claims: 0, unmatched: 0, validationError: parsed.validationError ?? "no_json_object", parseAttempts: parsed.parseAttempts };
	if (draft.status === "needs_human") {
		const qs = (Array.isArray(draft.questions) ? draft.questions : []).filter((q): q is string => typeof q === "string" && q.trim() !== "").map((q) => q.trim());
		return { ok: false, reason: "missing_information", questions: qs.length ? qs : ["The CLI needs more information but did not say what."], claims: 0, unmatched: 0, validationError: "incomplete_draft", parseAttempts: parsed.parseAttempts };
	}
	const resume = typeof draft.resume_markdown === "string" ? draft.resume_markdown.trim() : "";
	const coverLetter = typeof draft.cover_letter_markdown === "string" ? draft.cover_letter_markdown.trim() : "";
	const claims = Array.isArray(draft.claims) ? draft.claims : [];
	if (draft.status !== "ready" || !resume || !coverLetter || !claims.length) {
		return { ok: false, reason: "invalid_cli_output", questions: ["The CLI JSON was incomplete (missing a document or its source citations). Run it again."], claims: claims.length, unmatched: 0, validationError: "incomplete_draft", parseAttempts: parsed.parseAttempts };
	}
	const byRole = new Map(sources.map((s) => [s.role, normalize(s.text)] as const));
	const all = normalize(sources.map((s) => s.text).join("\n"));
	const questions: string[] = [];
	let unmatched = 0;
	const flag = (question: string) => {
		unmatched++;
		if (questions.length < 20) questions.push(question);
	};
	for (const raw of claims) {
		const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
		const quote = typeof c.quote === "string" ? normalize(c.quote) : "";
		const src = typeof c.source === "string" ? byRole.get(c.source as LocalArtifactSourceRole) : undefined;
		if (quote.length >= 3 && src?.includes(quote)) continue;
		const claim = typeof c.text === "string" ? c.text.trim() : "";
		flag(`Confirm or correct: “${claim.slice(0, 200) || "(an unnamed claim)"}” — no matching text was found in your ${typeof c.source === "string" ? c.source : "sources"}.`);
	}
	const text = `${resume}\n${coverLetter}`;
	const sourceDigits = digits(sources.map((s) => s.text).join("\n"));
	for (const y of new Set(text.match(YEAR) ?? [])) if (!all.includes(y)) flag(`Confirm the year ${y} — it does not appear in your sources.`);
	for (const e of new Set(text.match(EMAIL) ?? [])) if (!all.includes(e.toLowerCase())) flag("Confirm the email address in the draft — it does not appear in your sources.");
	// Nine digits or more, so a year range ("2019 - 2021") is not read as a phone number.
	for (const p of new Set(text.match(PHONE) ?? [])) if (digits(p).length >= 9 && !sourceDigits.includes(digits(p))) flag("Confirm the phone number in the draft — it does not appear in your sources.");
	if (unmatched) return { ok: false, reason: "uncertain_claim", questions, claims: claims.length, unmatched, validationError: "unverified_claim", parseAttempts: parsed.parseAttempts };
	return { ok: true, resume, coverLetter, claims: claims.length };
}
