/**
 * What a 404 from `fetch_url` actually means, said by the platform at the moment it happens
 * (#494, #493).
 *
 * ── Two shipped fixes, both violated within hours, both for the same reason
 *
 * #494 shipped the Deployment block (`deployment-prompt.ts`), which states the subscriber's
 * configured repo and says "it is authoritative … Never ask the subscriber for it". Fifty-two
 * minutes after that deploy landed, the owner asked his Operator "do you see now the repo URL and
 * the organization and the repo name or not?" — and the agent called `fetch_url` on the repo, got
 * a 404, and asked him to confirm the exact organisation and repository name.
 *
 * #493 shipped `TOOL_LIST_CLOSED`, which says "do NOT send the owner to Settings for it, because
 * this toolset is fixed by the agent's definition and is not a switch they can flip". Three hours
 * later, on the same instance, after the same shape of turn — a `fetch_url` that returned 404 —
 * the agent said "ask someone to grant this agent access."
 *
 * The block reached the model both times. Delivery was never the problem: the repo string the
 * agent put in that URL could only have come from the Deployment block, and `TOOL_LIST_CLOSED`'s
 * other clause was obeyed in the same turn (it did call the tool in-reply and report the 404).
 *
 * ── Why a third sentence would have failed the same way
 *
 * Both rules are STANDING INSTRUCTIONS in the system prompt, and both lost to EVIDENCE ACQUIRED
 * LATER IN THE SAME TURN. A 404 is a fact about the exact string that was requested. Given only
 * "the platform says this repo is authoritative" and "the server says this URL is not there", a
 * model that doubts the string is not being careless — with those two inputs and nothing else,
 * doubting it is the better inference. The prompt could forbid one wrong conclusion ("don't send
 * them to Settings") but it could not supply a right one, so the model produced a different wrong
 * conclusion instead. That is the whole of both incidents, and a rule saying "do not doubt the
 * repo on a 404" would be a third standing instruction arguing with the same fresh observation.
 *
 * ── The structural move: fill the gap, do not forbid the guess
 *
 * The 404 is ambiguous to the model and NOT ambiguous to the platform, which knows three things
 * it never says:
 *
 *   1. `fetch_url` attaches no credential. Its only header is a User-Agent (`tools.ts`), so every
 *      request it makes to github.com is anonymous.
 *   2. GitHub answers an anonymous request for a PRIVATE repository with 404, not 403 — it does
 *      not disclose existence. So a 404 here carries no information about the name at all.
 *   3. Whether this agent holds any `github_*` tool, resolved from `toolNamesFor`. If it does not,
 *      the missing thing is a TOOL, and no credential, consent or setting would supply it: the set
 *      is fixed by the agent's definition and `config.disabledTools` can only subtract from it.
 *
 * Stated in the tool result, those three facts leave nothing for the model to explain, so the
 * standing rules no longer have to win an argument against the evidence — the evidence agrees with
 * them. This is data, not instruction; it fires only on the turn that generates the confusion; and
 * it is derived per call, so it cannot assert something untrue of some other agent.
 *
 * It is the device #517 validated (`TOOL_REFUSAL_RELAY`: a refusal carries its own account and the
 * model relays THAT) applied at the one site #517 cannot reach — that sentence is scoped to "a tool
 * on this list", and the list is CONNECTED TOOLS, which `fetch_url` is not: it is BASE
 * (`agent-do-tools.ts`) and never appears in `connectorToolsPrompt`.
 *
 * ── Scope, deliberately narrow
 *
 * Only GitHub hosts, and only 401/403/404. A 200 needs no explanation, and a 5xx is a real server
 * failure whose obvious reading is the correct one — annotating those would be the platform
 * narrating over facts it has no better view of than the model does. GitLab and Bitbucket are
 * excluded because no connector in the registry exposes tools for them, so the "use your dedicated
 * tool instead" half has nothing to name; `HOSTS` is a table so adding one is a row.
 *
 * ── Why this never disturbs the fence
 *
 * `fetch_url` fences the response BODY and puts its own `HTTP <status>` framing outside it, so a
 * failure result is already not a bare fenced block and `unfenceUntrusted` already cannot match
 * it. Annotating only failure statuses keeps that true — and the note is appended after the closing
 * marker, in the platform's own voice, never inside the untrusted region.
 *
 * Pure: no I/O, no env. Everything it needs is the URL, the status, and the resolved tool names.
 */
import { isValidGithubRepo } from "./deployment-prompt.js";

/** The tool this speaks for. Nothing else in the catalog fetches an arbitrary URL uncredentialed. */
export const DIAGNOSED_TOOL = "fetch_url";

/**
 * Hosts the platform has a dedicated, credentialed connector for.
 *
 * Matched as the host itself or any subdomain of it, so `api.github.com`,
 * `raw.githubusercontent.com` and `gist.github.com` all resolve without enumerating them.
 */
const HOSTS: readonly { suffix: string; label: string; prefix: string }[] = [
	{ suffix: "github.com", label: "GitHub", prefix: "github_" },
	{ suffix: "githubusercontent.com", label: "GitHub", prefix: "github_" },
];

/** Statuses whose cause an anonymous caller cannot read off the number. */
const AMBIGUOUS = new Set([401, 403, 404]);

function hostEntry(url: string): (typeof HOSTS)[number] | null {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
	return HOSTS.find((h) => host === h.suffix || host.endsWith(`.${h.suffix}`)) ?? null;
}

/**
 * The platform's own reading of an HTTP status, per status.
 *
 * Each clause is a fact about how the HOST behaves, not a guess about this request: 404 hides
 * existence, 403 is the anonymous rate limit, 401 is a credential that was never sent. The model
 * cannot derive any of them from the number.
 */
function statusClause(status: number, label: string): string {
	if (status === 404)
		return (
			` ${label} answers an anonymous request for a PRIVATE repository with 404, not 403 — it does not` +
			" disclose whether a private repository exists. So this 404 is NOT evidence that the repository," +
			" organisation or name is wrong, and NOT evidence that it does not exist. It tells you only that" +
			" an anonymous caller may not see it."
		);
	if (status === 403)
		return (
			` ${label} rate-limits anonymous requests far more tightly than credentialed ones (60 per hour), and` +
			" also returns 403 where a credentialed caller would be allowed through. This says nothing about" +
			" whether the resource exists or whether its name is right."
		);
	return (
		` ${label} returned 401 because no credential was presented — not because a credential was rejected.` +
		" This says nothing about whether the resource exists or whether its name is right."
	);
}

/**
 * What to do instead, which is a different sentence depending on whether a dedicated tool exists.
 *
 * The two branches are the whole point of resolving the tool set rather than hardcoding a message.
 * Telling an agent that HOLDS `github_list_issues` that it has no way to reach GitHub would install
 * exactly the class of false statement #493 was filed about, pointed the other way.
 */
function remedyClause(names: readonly string[], label: string): string {
	if (names.length > 0)
		return (
			` You DO have dedicated ${label} tools — ${names.join(", ")} — and they authenticate through the` +
			" platform's GitHub App, so they can read what an anonymous fetch cannot. Call one of those instead" +
			" of retrying this URL."
		);
	return (
		` You have NO dedicated ${label} tool: nothing you can call authenticates to ${label}, and that is fixed` +
		" by this agent's definition. It is not a credential that is missing and not a permission anyone can" +
		" grant — a subscriber can switch a tool OFF but cannot add one. There is no access to request and no" +
		" setting that would change this result."
	);
}

/** Facts the model must not invent around. Shared by both branches because both were violated. */
const PROHIBITION =
	" Do not ask anyone to confirm the repository, organisation or name, do not ask anyone to grant access," +
	" and do not report this as a permission or credential problem. Answer from what you were already told," +
	" and say plainly what you cannot read.";

export interface FetchDiagnosisInput {
	/** The `url` argument the model passed. Anything non-string yields no note. */
	url: unknown;
	/** The response status. */
	status: number;
	/** The agent's RESOLVED tool names — post-allowlist, post-`disabledTools`. */
	toolNames?: ReadonlySet<string>;
	/** `config.githubRepo`, if the subscriber configured one. Validated with the Deployment block's own guard. */
	configuredRepo?: unknown;
}

/**
 * The note to append, or `""` when the platform knows nothing the model does not.
 *
 * Returning `""` is the common case by a wide margin — every successful fetch, every non-GitHub
 * host, every 5xx — so this is a couple of cheap checks on the hot path and nothing more.
 */
export function fetchUrlDiagnosis(input: FetchDiagnosisInput): string {
	if (typeof input.url !== "string" || !AMBIGUOUS.has(input.status)) return "";
	const entry = hostEntry(input.url);
	if (!entry) return "";
	const owned = [...(input.toolNames ?? [])].filter((n) => n.startsWith(entry.prefix)).sort();
	// Only when the fetched URL names the SAME repo the subscriber configured. A note asserting
	// "the configured repo is authoritative" against some unrelated URL would be a non sequitur,
	// and worse, would read as confirmation that the unrelated URL was the configured one.
	const repo = isValidGithubRepo(input.configuredRepo) ? input.configuredRepo.trim() : "";
	const namesConfigured = repo !== "" && input.url.toLowerCase().includes(repo.toLowerCase());
	return (
		"\n\nPLATFORM NOTE — read this status correctly before you explain it. `fetch_url` is a generic" +
		` fetcher: it sends no credential, so this request reached ${entry.label} ANONYMOUSLY.` +
		statusClause(input.status, entry.label) +
		remedyClause(owned, entry.label) +
		(namesConfigured
			? ` The repository \`${repo}\` is the subscriber's configured, authoritative value (see the Deployment` +
				" section above); this status does not contradict it and is not a reason to re-check it."
			: "") +
		PROHIBITION
	);
}

/**
 * Append the note to a `fetch_url` result, or return it untouched.
 *
 * Takes and returns the result shape rather than the string so the call site cannot accidentally
 * annotate a different tool: the name check lives here, once.
 */
export function annotateFetchResult<T extends { name: string; content: string }>(
	result: T,
	input: FetchDiagnosisInput,
): T {
	if (result.name !== DIAGNOSED_TOOL) return result;
	const note = fetchUrlDiagnosis(input);
	return note ? { ...result, content: result.content + note } : result;
}
