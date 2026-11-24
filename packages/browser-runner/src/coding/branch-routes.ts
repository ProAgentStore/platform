/**
 * The runner's branch endpoints (#1700), token-gated like the rest of `server.ts`.
 *
 *   POST /coding/branches          inventory (live remote heads, cached tracking refs, local branches), or with `compare` one branch against the default
 *   POST /coding/branch-integrate  fast-forward the default branch to a local branch's tip (`dryRun` previews)
 *   POST /coding/branch-delete     delete one exact local or remote branch (`dryRun` previews)
 *
 * Every one is addressed by repo (`repoId` / `workDir`), confined to a checkout by the runtime, and answers a
 * refusal as a value (`ok:false` + `reason`) so the cloud can name it; malformed input is a thrown InspectError,
 * which `server.ts` turns into a 400. The mutations preview unless `dryRun` is EXACTLY false. A separate file
 * because `server.ts` is over its size pin, and a function of (method, path, resolver) so it is testable
 * without a socket. Returns null for a path that is not one of these.
 */
import { branchInventory, compareBranch, deleteBranch, integrateBranch } from "./branches.js";
import { InspectError } from "./inspect.js";
import { liveGh } from "./merge-gh.js";

const PATHS = new Set(["/coding/branches", "/coding/branch-integrate", "/coding/branch-delete"]);

export async function handleBranchRoute(
	method: string,
	path: string,
	resolveWorkDir: (input: { workDir?: string; repoId?: string }) => string,
	readBody: () => Promise<Record<string, unknown>>,
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ body: unknown } | null> {
	if (method !== "POST" || !PATHS.has(path)) return null;
	const b = await readBody();
	const str = (k: string): string | undefined => (typeof b[k] === "string" && b[k] ? (b[k] as string) : undefined);
	const workDir = resolveWorkDir({ workDir: str("workDir"), repoId: str("repoId") });
	const dryRun = b.dryRun !== false;
	const gh = liveGh(workDir, env);
	if (path === "/coding/branches") {
		const compare = str("compare");
		return { body: compare ? compareBranch(workDir, { branch: compare, base: str("base") }) : await branchInventory(workDir, { gh }) };
	}
	if (path === "/coding/branch-integrate") return { body: await integrateBranch(workDir, { branch: str("branch") ?? "", expectedTip: str("expectedTip"), dryRun }, { gh }) };
	if (path === "/coding/branch-delete") {
		const scope = b.scope;
		if (scope !== "local" && scope !== "remote") throw new InspectError('`scope` must be "local" or "remote"');
		return { body: await deleteBranch(workDir, { scope, branch: str("branch") ?? "", expectedTip: str("expectedTip"), dryRun }, { gh }) };
	}
	return null;
}
