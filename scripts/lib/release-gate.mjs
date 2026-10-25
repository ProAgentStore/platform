/**
 * The release gate (#1321): a change to what an npm package SHIPS must come with a version npm does not already have.
 *
 * #1312's capability reporting changed the CLI's code and left `packages/cli/package.json` at 0.4.176. `publish-npm.yml` skips publishing
 * when that version is already on npm, and 0.4.176 had been published the day before, so the feature reached no machine: auto-update saw
 * nothing newer, and `get_machine_capabilities` said "not reported" on all five. Nothing failed - a green build shipped nothing.
 *
 * Pure, so the rule is tested as a rule; `scripts/check-release-version.mjs` does the git and npm reading.
 */

/** The published packages, the version file each is published from, and the source that goes into it. */
export const PACKAGES = [
	{
		name: "@proagentstore/cli",
		versionFile: "packages/cli/package.json",
		// The CLI bundles the browser runner (packages/cli/scripts/copy-browser-runner.mjs), so a change to either is a change to what it ships.
		sources: [/^packages\/cli\/src\//, /^packages\/cli\/scripts\//, /^packages\/browser-runner\/src\//],
	},
	{
		name: "@proagentstore/sdk",
		versionFile: "packages/sdk/package.json",
		sources: [/^packages\/sdk\/src\//],
	},
];

/** Files under a shipped source tree that never reach the package: tests, fixtures, docs. */
const NOT_SHIPPED = /(\.test\.|\.spec\.|\.fixture\.|\.contract\.test\.)|(^|\/)__tests__\/|\.md$/;

/** The changed files that go into `pkg`'s published tarball. */
export function shippedFiles(pkg, changed) {
	return changed.filter((f) => pkg.sources.some((re) => re.test(f)) && !NOT_SHIPPED.test(f));
}

/**
 * What is wrong, per package: shipped code changed and the version at HEAD is already published.
 * `versions`: { [name]: string | null } - the version in package.json at HEAD. `isPublished(name, version)`: boolean | null (null = unknown).
 * An unknown answer (npm unreachable) is not a failure: the gate cannot judge, and says so, rather than blocking a push on a registry outage.
 */
export function evaluateRelease({ changed, versions, isPublished }) {
	const problems = [];
	const unknown = [];
	for (const pkg of PACKAGES) {
		const files = shippedFiles(pkg, changed);
		if (!files.length) continue;
		const version = versions[pkg.name];
		if (!version) {
			problems.push({ pkg: pkg.name, version: null, files, why: `${pkg.versionFile} has no readable version` });
			continue;
		}
		const published = isPublished(pkg.name, version);
		if (published === null) unknown.push({ pkg: pkg.name, version, files });
		else if (published) problems.push({ pkg: pkg.name, version, files, why: `${pkg.name}@${version} is already on npm, so publish-npm would skip it and nothing below would reach a machine` });
	}
	return { ok: problems.length === 0, problems, unknown };
}

const MAX_LISTED = 8;

export function formatProblems(result) {
	const out = [];
	for (const p of result.problems) {
		const more = p.files.length - MAX_LISTED;
		out.push(`✗ ${p.pkg}: ${p.why}.`, ...p.files.filter((_, i) => i < MAX_LISTED).map((f) => `    changed: ${f}`), ...(more > 0 ? [`    … and ${more} more`] : []));
	}
	if (result.problems.length) out.push("\n  Bump the version in the package's package.json (e.g. 0.4.180 → 0.4.181) in the same push. A change to shipped code that keeps the published version ships to nobody (#1321).");
	for (const u of result.unknown) out.push(`? ${u.pkg}@${u.version}: npm could not be asked whether this version is published, so the gate could not judge ${u.files.length} shipped file(s).`);
	return out.join("\n");
}
