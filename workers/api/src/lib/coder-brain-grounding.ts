/**
 * The coder brain's grounding (#1026): what it reads, read-only, before it may decide. Each source is labelled,
 * and a decision must cite those labels as its evidence — a decision citing nothing it was given counts as
 * below threshold (`coder-brain-decide.ts`). No write tool, no secret, no GitHub write: reads only, with the
 * owner's installation token where a private repo needs one.
 *
 * 1. the issue and its comments (already gathered), plus the issues they link (`#N`, same repo)
 * 2. the backlog: open and recently closed issue titles and labels — product direction
 * 3. product docs: CLAUDE.md (already gathered), README.md, AGENTS.md and the `docs/` files whose names share
 *    a word with the question
 * 4. code: the files the question, its reason, the issue or the terminal tail name, plus recent commits
 * 5. earlier answered questions on this instance — human and brain — so it stays consistent
 */
import type { Env } from "../types.js";
import { clipMarked } from "./clip-marked.js";
import type { DecisionContext } from "./coder-brain-decide.js";
import { listIssues, listRepoDir, readIssue, readRepoText } from "./github-issues.js";

export type Grounding = Pick<DecisionContext, "linkedIssues" | "backlog" | "docs" | "files" | "priorDecisions">;

const MAX_LINKED = 5;
const MAX_DOCS = 4;
const MAX_FILES = 3;
const FILE_RE = /(?:^|[\s`'"(])((?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|md|json|ya?ml|toml|sql|css|scss|html))(?=[\s`'"),:.?!;]|$)/g;
const STOP = new Set(["the", "and", "for", "with", "this", "that", "should", "which", "what", "from", "into", "when", "will", "would", "does", "have"]);

/** Every distinct `#N` in the text other than the issue itself. */
export function linkedIssueNumbers(texts: readonly string[], self: number | null): number[] {
	const out = new Set<number>();
	for (const t of texts) for (const m of t.matchAll(/(?:^|[^\w/])#(\d{1,6})\b/g)) if (Number(m[1]) !== self) out.add(Number(m[1]));
	return [...out].slice(0, MAX_LINKED);
}

/** Repo-relative paths the text names, without a scheme or a leading slash. */
export function namedFiles(texts: readonly string[]): string[] {
	const out = new Set<string>();
	for (const t of texts) for (const m of t.matchAll(FILE_RE)) if (!m[1].includes("://") && !m[1].startsWith(".")) out.add(m[1].replace(/^\.?\//, ""));
	return [...out].slice(0, MAX_FILES);
}

const words = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.has(w)));

export async function gatherGrounding(
	env: Env,
	input: { userId: string; instanceId: string; repo: string | null; issueNumber: number | null; question: string; why: string | null; options: string[]; issueBody: string; comments: string[]; paneTail: string | null },
): Promise<Grounding> {
	const { userId, repo } = input;
	const priorDecisions = await priorDecisionsOf(env, input.instanceId, input.question);
	if (!repo) return { linkedIssues: [], backlog: [], docs: [], files: [], priorDecisions };
	const texts = [input.question, input.why ?? "", ...input.options, input.issueBody, ...input.comments];
	const linked = await Promise.all(linkedIssueNumbers(texts, input.issueNumber).map((n) => readIssue(env, userId, repo, n).catch(() => null)));
	const [open, closed] = await Promise.all([
		listIssues(env, userId, repo, { state: "open", limit: 30 }).catch(() => []),
		listIssues(env, userId, repo, { state: "closed", limit: 15 }).catch(() => []),
	]);
	const backlog = [...open, ...closed]
		.filter((i) => i.number !== input.issueNumber)
		.map((i) => `#${i.number} [${i.state}] ${clipMarked(i.title, 140, { within: true })}${i.labels.length ? ` (${i.labels.join(", ")})` : ""}`);
	const asked = words([input.question, input.why ?? "", ...input.options].join(" "));
	const docPaths = (await listRepoDir(env, userId, repo, "docs").catch(() => []))
		.filter((p) => /\.mdx?$/i.test(p) && [...words(p)].some((w) => asked.has(w)))
		.slice(0, MAX_DOCS - 2);
	const docs = (
		await Promise.all(["README.md", "AGENTS.md", ...docPaths].map(async (path) => ({ path, text: await readRepoText(env, userId, repo, path, 8_000).catch(() => null) })))
	).flatMap((d) => (d.text ? [{ path: d.path, text: d.text }] : []));
	const files = (
		await Promise.all(namedFiles([...texts, input.paneTail ?? ""]).map(async (path) => ({ path, text: await readRepoText(env, userId, repo, path, 8_000).catch(() => null) })))
	).flatMap((f) => (f.text ? [{ path: f.path, text: f.text }] : []));
	return {
		linkedIssues: linked.flatMap((i) => (i ? [{ number: i.number, title: i.title, state: i.state, body: clipMarked(i.body ?? "", 2000) }] : [])),
		backlog,
		docs,
		files,
		priorDecisions,
	};
}

/** Answered questions on this instance, newest first — who answered and what, so the brain stays consistent. */
async function priorDecisionsOf(env: Env, instanceId: string, current: string): Promise<string[]> {
	const { results } = await env.DB.prepare(
		"SELECT question, decision, answered_by FROM coder_questions WHERE instance_id = ?1 AND state IN ('answered_human', 'answered_brain') AND decision IS NOT NULL AND question <> ?2 ORDER BY resolved_at DESC LIMIT 10",
	)
		.bind(instanceId, current)
		.all<{ question: string; decision: string; answered_by: string | null }>();
	return (results ?? []).map((r) => `${r.answered_by === "brain" ? "brain" : "owner"} answered "${clipMarked(r.question, 160, { within: true })}" → ${clipMarked(r.decision, 160, { within: true })}`);
}
