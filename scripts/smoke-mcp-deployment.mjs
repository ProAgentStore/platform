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

async function main() {
	const sources = await Promise.all(
		["server-version", "tool-count", "surface-lock"].map((name) =>
			readFile(
				new URL(`../workers/mcp/src/${name}.ts`, import.meta.url),
				"utf8",
			),
		),
	);
	const expected = expectedIdentity(...sources, process.env.GITHUB_SHA);
	let failure;
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			const response = await fetch("https://mcp.proagentstore.online/health", {
				signal: AbortSignal.timeout(10000),
				cache: "no-store",
			});
			if (!response.ok) throw new Error(`MCP health HTTP ${response.status}`);
			assertIdentity(await response.json(), expected);
			console.log(
				`MCP deployment verified: ${expected.server_version} ${expected.build_commit}`,
			);
			return;
		} catch (error) {
			failure = error;
		}
		if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 5000));
	}
	throw failure;
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
