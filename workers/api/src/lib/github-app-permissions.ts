/**
 * The GitHub App's permissions as the platform's code needs them (#1207) — the TypeScript mirror of
 * `scripts/lib/github-app-permissions.mjs` (a test keeps the two equal), used so every refusal names ALL the permissions to grant,
 * not just the one that happened to produce the 403: an operator should be able to fix the App in one visit.
 */
export const REQUIRED_APP_PERMISSIONS: Record<string, "read" | "write"> = {
	actions: "read",
	contents: "read",
	issues: "write",
	members: "read",
	metadata: "read",
	organization_self_hosted_runners: "write",
	actions_variables: "write",
	organization_administration: "read",
};

/** What to grant, in the words of GitHub's settings page, and where it has to be accepted. */
export const GRANT_ALL_HINT =
	"Grant all three the runner work needs in one go — Organization → Self-hosted runners: Read and write; Repository → Variables: Read and write; Organization → Administration: Read-only — then accept them on each org's installation (#1207; `node scripts/check-github-app-permissions.mjs` shows what is still missing).";
