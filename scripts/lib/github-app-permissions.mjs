/**
 * What the ProAgentStore GitHub App (`proagentstore`, id 4460892) must be allowed to do, and the comparison that says what is missing (#1207).
 *
 * GitHub keeps an App's permissions in its settings, not in a file here, so this list is the repo's record of what the code needs: the five
 * the platform already used plus the three the self-hosted runner work (#1113) added. `workers/api/src/lib/github-app-permissions.ts` mirrors it
 * for the error messages (a test keeps the two equal). Pure — `scripts/check-github-app-permissions.mjs` does the reading.
 */

/** API key → the lowest level the code needs. `why` is for the report. */
export const REQUIRED_APP_PERMISSIONS = {
	actions: { level: "read", why: "workflow runs, jobs and logs" },
	contents: { level: "read", why: "repository files" },
	issues: { level: "write", why: "issues and comments" },
	members: { level: "read", why: "org membership" },
	metadata: { level: "read", why: "repository metadata" },
	organization_self_hosted_runners: { level: "write", why: "runner registration tokens, runner removal and labels (#1208, #1209)" },
	actions_variables: { level: "write", why: "the PAGS_RUNNER variable (#1212)" },
	organization_administration: { level: "read", why: "the Actions billing usage report (#1212)" },
};

/** GitHub's three levels, lowest first: `admin` satisfies `write` satisfies `read`. */
const RANK = { read: 1, write: 2, admin: 3 };

/** Does a held level meet a required one? An unknown or absent level never does. */
export function meets(held, required) {
	return (RANK[held] ?? 0) >= (RANK[required] ?? Number.POSITIVE_INFINITY);
}

/** The required permissions that `held` (an API `permissions` object) does not meet: [{ key, required, held, why }]. */
export function missingPermissions(held, required = REQUIRED_APP_PERMISSIONS) {
	const have = held && typeof held === "object" ? held : {};
	return Object.entries(required)
		.filter(([key, r]) => !meets(have[key], r.level))
		.map(([key, r]) => ({ key, required: r.level, held: typeof have[key] === "string" ? have[key] : null, why: r.why }));
}

/**
 * Compare the App's configured permissions and each org installation's accepted ones.
 * `installations`: [{ org, permissions } | { org, error }] — `error` when the installation could not be read.
 * Returns { ok, app: [missing…], orgs: [{ org, missing?, error? }] }.
 */
export function comparePermissions({ app, installations }, required = REQUIRED_APP_PERMISSIONS) {
	const appMissing = app?.error ? null : missingPermissions(app?.permissions, required);
	const orgs = installations.map((i) => (i.error ? { org: i.org, error: i.error } : { org: i.org, missing: missingPermissions(i.permissions, required) }));
	const ok = appMissing !== null && appMissing.length === 0 && orgs.every((o) => !o.error && o.missing.length === 0);
	return { ok, app: appMissing, appError: app?.error ?? null, orgs };
}

const line = (m) => `    - ${m.key}: needs ${m.required}${m.held ? `, has ${m.held}` : ", not granted"} (${m.why})`;

/** The report a person reads. */
export function formatReport(result) {
	const out = [];
	if (result.appError) out.push(`✗ The App itself could not be read: ${result.appError}`);
	else if (result.app.length) out.push("✗ The App's configured permissions are missing:", ...result.app.map(line), "  Add them at https://github.com/organizations/ProAgentStore/settings/apps/proagentstore/permissions, then Save changes.");
	else out.push("✓ The App's configured permissions are complete.");
	for (const o of result.orgs) {
		if (o.error) out.push(`? ${o.org}: the installation could not be read (${o.error}), so it is NOT confirmed.`);
		else if (o.missing.length) out.push(`✗ ${o.org}: not accepted on the installation:`, ...o.missing.map(line), `  Accept at https://github.com/organizations/${o.org}/settings/installations (Review request).`);
		else out.push(`✓ ${o.org}: the installation has everything accepted.`);
	}
	out.push(result.ok ? "\nAll permissions are granted and accepted." : "\nNot satisfied yet.");
	return out.join("\n");
}

/**
 * Read the App and its installations in `orgs` through `get(path) → parsed JSON` (throws on a non-2xx).
 * The App's own permissions are public; an org's installations need an org-admin token.
 */
export async function readState(get, orgs, slug = "proagentstore") {
	let app;
	try {
		app = { permissions: (await get(`/apps/${slug}`)).permissions ?? {} };
	} catch (e) {
		app = { error: e instanceof Error ? e.message : String(e) };
	}
	const installations = [];
	for (const org of orgs) {
		try {
			const found = ((await get(`/orgs/${org}/installations`)).installations ?? []).find((i) => i.app_slug === slug);
			installations.push(found ? { org, permissions: found.permissions ?? {} } : { org, error: `the ${slug} App is not installed on ${org}` });
		} catch (e) {
			installations.push({ org, error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
		}
	}
	return { app, installations };
}
