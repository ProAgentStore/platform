import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function expectedIdentity(
	versionSource,
	countSource,
	lockSource,
	buildCommit,
) {
	const version = versionSource.match(
		/export const MCP_SERVER_VERSION = "([^"]+)"/,
	)?.[1];
	const count = Number(
		countSource.match(/export const MCP_TOOL_COUNT = (\d+)/)?.[1],
	);
	const revision = lockSource.match(
		new RegExp(`"${version?.replaceAll(".", "\\.")}": "([^"]+)"`),
	)?.[1];
	if (!version || !count || !revision || !buildCommit)
		throw new Error("Missing expected deployment identity");
	return {
		server_name: "ProAgentStore",
		server_version: version,
		tool_count: count,
		schema_revision: revision,
		build_commit: buildCommit,
	};
}

export function assertIdentity(actual, expected) {
	for (const [key, value] of Object.entries(expected)) {
		if (actual[key] !== value)
			throw new Error(
				`MCP deployment ${key}: expected ${value}, received ${actual[key]}`,
			);
	}
	if (
		actual.ok !== true ||
		!actual.deployed_at ||
		actual.deployed_at === "unknown"
	)
		throw new Error("MCP deployment health/timestamp missing");
}

/**
 * Poll the public endpoint until it serves exactly the expected identity (#1051). A successful
 * Workers deploy can take a while to reach every edge, so a stale identity is retried — but only
 * until the bounded window closes, and only an exact match ever succeeds: an older version is
 * never accepted. Every attempt logs expected vs observed and elapsed time.
 */
export async function pollIdentity({
	expected,
	fetchHealth,
	windowMs = 180_000,
	intervalMs = 10_000,
	now = Date.now,
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	log = console.log,
}) {
	const started = now();
	const elapsed = () => `${((now() - started) / 1000).toFixed(1)}s`;
	let failure;
	let observed;
	for (let attempt = 1; ; attempt++) {
		let current;
		try {
			current = await fetchHealth();
			observed = current;
			assertIdentity(current, expected);
			log(
				`MCP deployment verified after ${elapsed()} (attempt ${attempt}): ${expected.server_version} ${expected.build_commit}`,
			);
			return { attempts: attempt, elapsedMs: now() - started };
		} catch (error) {
			failure = error;
			log(
				`attempt ${attempt} at ${elapsed()}: expected ${expected.server_version} ${expected.build_commit}, observed ${current?.server_version ?? "-"} ${current?.build_commit ?? "-"} — ${error.message}`,
			);
		}
		if (now() - started + intervalMs > windowMs) break;
		await sleep(intervalMs);
	}
	throw new Error(
		[
			`MCP deployment not serving the expected identity after ${elapsed()} (window ${windowMs / 1000}s).`,
			`Last error: ${failure.message}`,
			`Expected: ${JSON.stringify(expected)}`,
			`Observed: ${observed ? JSON.stringify(observed) : "no successful health response"}`,
			"If the observed build is the previous commit, the new version never went live: check the deploy step's Current Version ID in the Cloudflare dashboard (Workers > proagentstore-mcp > Deployments) and that the mcp.proagentstore.online route points at it, then re-run this workflow.",
		].join("\n"),
	);
}

async function main() {
	const sources = await Promise.all(
		["server-version", "tool-count", "surface-lock"].map((name) =>
			readFile(
				new URL(`../workers/mcp/src/${name}.ts`, import.meta.url),
				"utf8",
			),
		),
	);
	await pollIdentity({
		expected: expectedIdentity(...sources, process.env.GITHUB_SHA),
		fetchHealth: async () => {
			const response = await fetch("https://mcp.proagentstore.online/health", {
				signal: AbortSignal.timeout(10000),
				cache: "no-store",
			});
			if (!response.ok) throw new Error(`MCP health HTTP ${response.status}`);
			return response.json();
		},
	});
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
