/**
 * The issue a coding question is about, read from the run's bound session/ticket (#1363).
 *
 * Everything here is TRUSTED provenance: the repository and issue number come from the registered coding repo and the
 * session or ticket that is bound to the run, and the title, state and summary come from the ticket's issue cache that
 * the issue sync keeps. Nothing is read from the agent's question or its `#number` prose, and nothing here calls GitHub:
 * a question is delivered whether or not GitHub is reachable (the board reads the same cache for the same reason).
 *
 * Because the cache is a snapshot, a decision premise built on it can go stale. {@link assessStaleness} says so with a
 * reason the owner can act on, from facts the platform holds. It never rewrites or answers the question.
 */
import type { Env } from "../types.js";
import { clipMarked } from "./clip-marked.js";
import { type IssueCache, parseIssueCache } from "./issue-tickets.js";

/** Why a question's source context needs a refresh before it is trusted as a premise for a decision. */
export type QuestionStaleReason = "issue_closed" | "issue_changed_since_asked" | "context_old";

/**
 * `linked`: a trusted issue is bound to the run. `none`: nothing is bound (an ad-hoc run, or a repo with no issue), which
 * is a normal answer. `unavailable`: the lookup itself failed, so we do not know. Clients must tell the last two apart.
 */
export type QuestionSourceStatus = "linked" | "none" | "unavailable";

export interface CodingQuestionIssue {
	repo: string;
	number: number;
	title: string;
	url: string;
	summary?: string;
	/** The issue's state as last synced (`open` / `closed`). Absent when the cache has none. */
	issueState?: string;
	/** GitHub's `updatedAt` for the issue as last synced. */
	issueUpdatedAt?: string;
	/** Milliseconds since the ticket's issue cache was last written, at the time this was read. */
	cacheAge?: number;
	/** True when the context may no longer be a safe premise; `staleReason` and `staleDetail` say why. */
	stale?: boolean;
	staleReason?: QuestionStaleReason;
	staleDetail?: string;
}

export interface CodingQuestionSource {
	status: QuestionSourceStatus;
	issue: CodingQuestionIssue | null;
}

/** A cached issue older than this is flagged: the owner is deciding on a day-old picture. */
export const CONTEXT_OLD_MS = 24 * 3_600_000;

/** A URL is made only from a registered GitHub repository and an issue number, never question prose. */
export function codingQuestionIssueUrl(repo: unknown, number: unknown): string | null {
	if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return null;
	// `.` and `..` match the character class but are path steps: `../x` would normalize to another repository's issue.
	if (repo.split("/").some((part) => part === "." || part === "..")) return null;
	if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) return null;
	return `https://github.com/${repo}/issues/${number}`;
}

const hours = (ms: number) => (ms < 3_600_000 ? "under an hour" : ms < 48 * 3_600_000 ? `${Math.round(ms / 3_600_000)} hours` : `${Math.round(ms / 86_400_000)} days`);

/**
 * Is the cached picture of the issue still a safe premise? Judged only from what the platform holds, never by reading the
 * question's words:
 *   issue_closed               the issue is no longer open, so a question about how to implement it is probably moot
 *   issue_changed_since_asked  GitHub updated the issue after the question was asked (new comments, a rewritten spec)
 *   context_old                the cache has not been refreshed for a day
 * The first that applies wins, in that order. `syncedAt` is when the ticket cache was last written (epoch ms).
 */
export function assessStaleness(cache: IssueCache | null, at: { askedAt?: number | null; now: number; syncedAt?: number | null }): Pick<CodingQuestionIssue, "issueState" | "issueUpdatedAt" | "cacheAge" | "stale" | "staleReason" | "staleDetail"> {
	const cacheAge = at.syncedAt && Number.isFinite(at.syncedAt) ? Math.max(0, at.now - at.syncedAt) : undefined;
	const base = {
		...(cache?.state ? { issueState: cache.state } : {}),
		...(cache?.updatedAt ? { issueUpdatedAt: cache.updatedAt } : {}),
		...(cacheAge !== undefined ? { cacheAge } : {}),
	};
	if (!cache) return base;
	const stale = (staleReason: QuestionStaleReason, staleDetail: string) => ({ ...base, stale: true as const, staleReason, staleDetail });
	if (cache.state.toLowerCase() !== "open") return stale("issue_closed", `the source issue is ${cache.state.toLowerCase()}${cache.closedAt ? ` (since ${cache.closedAt.split("T")[0]})` : ""}, so what this question assumes may no longer hold`);
	const updated = Date.parse(cache.updatedAt);
	if (at.askedAt && Number.isFinite(updated) && updated > at.askedAt) return stale("issue_changed_since_asked", "the source issue was updated after this question was asked");
	if (cacheAge !== undefined && cacheAge > CONTEXT_OLD_MS) return stale("context_old", `the issue context was last refreshed ${hours(cacheAge)} ago`);
	return base;
}

/** SQLite `datetime('now')` text (UTC, no zone) as epoch ms. */
const sqliteMs = (s: string | null | undefined) => {
	const ms = s ? Date.parse(`${s.replace(" ", "T")}Z`) : Number.NaN;
	return Number.isFinite(ms) ? ms : null;
};

/**
 * The run's source issue and how sure we are about it. Never throws and never calls GitHub: a lookup failure is
 * `unavailable` (an answer in itself), no binding is `none`. `askedAt` (epoch ms) lets a changed issue be noticed.
 */
export async function codingQuestionSource(
	env: Pick<Env, "DB">,
	input: { instanceId: string; userId: string; sessionId: string; runId?: string | null },
	opts: { askedAt?: number | null; now?: number } = {},
): Promise<CodingQuestionSource> {
	let row: { repo: string | null; issue_number: number | null; issue_cache: string | null; synced: string | null } | null;
	try {
		row = await env.DB.prepare(
			`SELECT r.github_repo AS repo, COALESCE(s.issue_number, t.issue_number) AS issue_number, t.issue_cache, t.updated_at AS synced
		   FROM coding_sessions s
		   JOIN coding_repos r ON r.id = s.repo_id AND r.instance_id = s.instance_id
		   LEFT JOIN agent_loop_runs l ON l.run_id = ?4 AND l.session_id = s.id AND l.instance_id = s.instance_id AND l.user_id = s.user_id
		   LEFT JOIN tickets t ON t.id = l.ticket_id AND t.instance_id = s.instance_id AND t.user_id = s.user_id
		  WHERE s.id = ?1 AND s.instance_id = ?2 AND s.user_id = ?3`,
		)
			.bind(input.sessionId, input.instanceId, input.userId, input.runId ?? "")
			.first();
	} catch {
		return { status: "unavailable", issue: null };
	}
	const number = Number(row?.issue_number);
	const url = codingQuestionIssueUrl(row?.repo, number);
	if (!url || !row?.repo) return { status: "none", issue: null };
	const cache = parseIssueCache(row.issue_cache);
	const trusted = cache?.number === number && cache.repo.toLowerCase() === row.repo.toLowerCase() ? cache : null;
	const summary = trusted?.summary?.trim();
	return {
		status: "linked",
		issue: {
			repo: row.repo,
			number,
			title: trusted?.title?.trim() || `Issue #${number}`,
			url,
			...(summary ? { summary: clipMarked(summary, 320, { within: true }) } : {}),
			...assessStaleness(trusted, { askedAt: opts.askedAt, now: opts.now ?? Date.now(), syncedAt: sqliteMs(row.synced) }),
		},
	};
}

/** The linked issue only; see {@link codingQuestionSource} for the status that tells "none" from "unavailable". */
export async function codingQuestionIssue(
	env: Pick<Env, "DB">,
	input: { instanceId: string; userId: string; sessionId: string; runId?: string | null },
	opts: { askedAt?: number | null; now?: number } = {},
): Promise<CodingQuestionIssue | null> {
	return (await codingQuestionSource(env, input, opts)).issue;
}

/** One sentence for a notification or thread: what is wrong with the source context, or "" when nothing is. */
export function questionSourceNotice(source: Pick<CodingQuestionSource, "status" | "issue"> | null | undefined): string {
	if (!source) return "";
	if (source.status === "unavailable") return "The source issue could not be loaded, so check the run before answering.";
	if (source.issue?.stale) return `Needs refresh: ${source.issue.staleDetail ?? "the source issue context may be out of date"}. Check the issue before answering; the question is unchanged.`;
	return "";
}

/** `repo#N — title. url` for a linked issue, else the plain repo label. */
export function questionSourceLead(issue: CodingQuestionIssue | null | undefined, repoLabel: string): string {
	return issue ? `${issue.repo}#${issue.number} — ${issue.title}. ${issue.url}` : repoLabel;
}

/** The question rows of the coder_questions surface, with the source context beside each (#1363). */
export interface QuestionSourceFields {
	issueStatus: QuestionSourceStatus;
	issueTitle?: string;
	issueSummary?: string;
	issueState?: string;
	issueUpdatedAt?: string;
	cacheAge?: number;
	stale?: boolean;
	staleReason?: QuestionStaleReason;
	staleDetail?: string;
}

export function questionSourceFields(source: CodingQuestionSource): QuestionSourceFields {
	const i = source.issue;
	return {
		issueStatus: source.status,
		...(i ? { issueTitle: i.title } : {}),
		...(i?.summary ? { issueSummary: i.summary } : {}),
		...(i?.issueState ? { issueState: i.issueState } : {}),
		...(i?.issueUpdatedAt ? { issueUpdatedAt: i.issueUpdatedAt } : {}),
		...(i?.cacheAge !== undefined ? { cacheAge: i.cacheAge } : {}),
		...(i?.stale ? { stale: true, staleReason: i.staleReason, staleDetail: i.staleDetail } : {}),
	};
}

const REASONS: readonly string[] = ["issue_closed", "issue_changed_since_asked", "context_old"];
export const isQuestionSourceStatus = (v: unknown): v is QuestionSourceStatus => v === "linked" || v === "none" || v === "unavailable";

/**
 * An issue read back from stored JSON (a parked ask, an event payload). The URL must still be the one built from its own
 * repository and number, and every extra field must have the right type, so a stored value cannot smuggle a link or a flag.
 */
export function sanitizeQuestionIssue(raw: unknown): CodingQuestionIssue | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	if (typeof o.repo !== "string" || typeof o.number !== "number" || o.url !== codingQuestionIssueUrl(o.repo, o.number)) return null;
	return {
		repo: o.repo,
		number: o.number,
		title: typeof o.title === "string" && o.title.trim() ? o.title : `Issue #${o.number}`,
		url: o.url as string,
		...(typeof o.summary === "string" && o.summary ? { summary: o.summary } : {}),
		...(typeof o.issueState === "string" && o.issueState ? { issueState: o.issueState } : {}),
		...(typeof o.issueUpdatedAt === "string" && o.issueUpdatedAt ? { issueUpdatedAt: o.issueUpdatedAt } : {}),
		...(typeof o.cacheAge === "number" && Number.isFinite(o.cacheAge) && o.cacheAge >= 0 ? { cacheAge: o.cacheAge } : {}),
		...(o.stale === true && typeof o.staleReason === "string" && REASONS.includes(o.staleReason)
			? { stale: true as const, staleReason: o.staleReason as QuestionStaleReason, ...(typeof o.staleDetail === "string" ? { staleDetail: o.staleDetail } : {}) }
			: {}),
	};
}

/** What a question row needs to find its source: the bound session and run, and when it was asked. */
interface QuestionRef { instanceId: string; userId: string; sessionId: string; runId: string | null; askedAt: number }

/** The source context for each question, DB-only and in parallel; one that cannot be read is reported `unavailable`, never dropped. */
export async function withQuestionSources<Q extends QuestionRef>(env: Pick<Env, "DB">, questions: Q[]): Promise<Array<Q & QuestionSourceFields>> {
	return Promise.all(questions.map(async (q) => ({ ...q, ...questionSourceFields(await codingQuestionSource(env, { instanceId: q.instanceId, userId: q.userId, sessionId: q.sessionId, runId: q.runId }, { askedAt: q.askedAt })) })));
}

/** The "Source: …" tail of a coder-question push: where it comes from, what is stale, and what could not be loaded. */
export function questionSourceTail(source: CodingQuestionSource): string {
	const lead = source.issue ? ` Source: ${questionSourceLead(source.issue, "")}` : source.status === "none" ? " No issue is linked to this run." : "";
	const notice = questionSourceNotice(source);
	return `${lead}${notice ? ` ${notice}` : ""}`;
}
