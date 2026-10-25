#!/usr/bin/env node
/**
 * check-github-app-permissions.mjs — is the GitHub App allowed to do what the platform needs (#1207)?
 *
 * Reads the App's configured permissions (`GET /apps/proagentstore`, public) and what each org's installation has ACCEPTED
 * (`GET /orgs/{org}/installations`, needs an org-admin `gh` login), and prints what is missing and where. Read-only.
 * Exit 0 only when the App and every listed org are fully satisfied; an installation it cannot read counts as not confirmed.
 *
 * Run: `node scripts/check-github-app-permissions.mjs [org ...]`   (default orgs: ProAgentStore proappstore-online)
 * Not part of CI: it needs a GitHub login with org-admin rights, and the state it checks is the owner's to change.
 */
import { execFileSync } from "node:child_process";
import { comparePermissions, formatReport, readState } from "./lib/github-app-permissions.mjs";

const DEFAULT_ORGS = ["ProAgentStore", "proappstore-online"];

function ghGet(path) {
	try {
		return JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
	} catch (e) {
		throw new Error(String(e.stderr || e.message || e).trim());
	}
}

async function main() {
	const orgs = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_ORGS;
	const result = comparePermissions(await readState(async (p) => ghGet(p), orgs));
	console.log(formatReport(result));
	process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
