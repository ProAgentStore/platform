import {
	checkManifest,
	checkMetadata,
	checkModel,
	checkSecurity,
	checkStructure,
	checkWrangler,
} from "./checks/index.js";
import type { CheckResult } from "./types.js";
export type { CheckResult } from "./types.js";

type CheckFn = (dir: string) => Promise<CheckResult[]>;

const checks: CheckFn[] = [
	checkManifest,
	checkWrangler,
	checkSecurity,
	checkStructure,
	checkMetadata,
	checkModel,
];

/** Run all compliance checks on an agent directory. */
export async function runChecks(agentDir: string): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	for (const check of checks) {
		results.push(...(await check(agentDir)));
	}
	return results;
}

export {
	checkManifest,
	checkMetadata,
	checkModel,
	checkSecurity,
	checkStructure,
	checkWrangler,
} from "./checks/index.js";
