/**
 * The Workers AI credential check a brain pick runs before it is accepted (#853 finding 8).
 * Split out of `user-ai.ts`, which reads and decrypts the credentials this asks Cloudflare about.
 */
import type { Env } from "../types.js";
import { getUserCloudflareAiCredentials, type StoredCloudflareAiCredentials } from "./user-ai.js";

/** The Cloudflare statuses that mean "these credentials do not work" — 400 is its bad-token answer, 404 a bad account id. */
const CLOUDFLARE_CREDENTIAL_REFUSALS = new Set([400, 401, 403, 404]);

/**
 * Why the owner's stored Cloudflare credentials cannot run a Workers AI brain, checked against
 * Cloudflare itself — or null when they can (#853 finding 8).
 *
 * A row existing is not a credential that works: a mistyped token, a revoked one or the wrong account
 * id was accepted on the row alone, and every turn then fell back to Anthropic without a word. This
 * asks Cloudflare for one model through the same account path a turn uses, so the account id and the
 * token's Workers AI access are both exercised. `status` is the answer's: 400 when the credentials are
 * at fault, 502 when Cloudflare could not be asked — a pick that was not checked is not accepted.
 */
export async function cloudflareAiCredentialProblem(env: Env, userId: string): Promise<{ status: 400 | 502; error: string } | null> {
	let credentials: StoredCloudflareAiCredentials;
	try {
		credentials = await getUserCloudflareAiCredentials(env, userId);
	} catch (e) {
		return {
			status: 400,
			error: `Your stored Cloudflare Workers AI credentials cannot be read (${e instanceof Error ? e.message : String(e)}). Re-add your Cloudflare account ID and API token in Profile → API Keys, then pick it again.`,
		};
	}
	let res: Response;
	try {
		res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId)}/ai/models/search?per_page=1`, {
			headers: { Authorization: `Bearer ${credentials.token}` },
			signal: AbortSignal.timeout(10_000),
		});
	} catch (e) {
		return {
			status: 502,
			error: `Could not reach Cloudflare to check your Workers AI credentials (${e instanceof Error ? e.message : String(e)}) — nothing was changed. Pick the model again in a moment.`,
		};
	}
	if (res.ok) return null;
	if (!CLOUDFLARE_CREDENTIAL_REFUSALS.has(res.status)) {
		return { status: 502, error: `Cloudflare answered HTTP ${res.status} when checking your Workers AI credentials — nothing was changed. Pick the model again in a moment.` };
	}
	const said = await (res.json() as Promise<{ errors?: Array<{ message?: string }> }>)
		.then((d) => d.errors?.map((x) => x.message).filter(Boolean).join("; ") ?? "")
		.catch(() => "");
	return {
		status: 400,
		error: `Cloudflare rejected your stored Workers AI credentials (HTTP ${res.status}: ${said || "no reason given"}) — the API token is wrong, expired or revoked, lacks Workers AI access, or the account ID is not its account. Re-add them in Profile → API Keys, then pick it again. Nothing was changed.`,
	};
}
