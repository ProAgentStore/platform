// Pure pieces of the release smoke test (#1152): picking the previous release, building the registry's answer for the
// candidate, and reading what the fake platform saw. The runner of it (run.mjs) is the only part that starts processes.
import { createHash } from "node:crypto";

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
/** -1 | 0 | 1 for plain `major.minor.patch` versions (the only kind this package publishes); null when either is not one. */
export function compareVersions(a, b) {
	const x = VERSION.exec(a);
	const y = VERSION.exec(b);
	if (!x || !y) return null;
	for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) < Number(y[i]) ? -1 : 1;
	return 0;
}

/** The newest published version strictly older than the candidate — what a machine would be running before it updates. Null if none. */
export function previousRelease(published, candidate) {
	const older = published.filter((v) => compareVersions(v, candidate) === -1);
	older.sort((a, b) => compareVersions(b, a));
	return older[0] ?? null;
}

/**
 * The registry packument the fake serves for the CLI package: the candidate (a local tarball) as `latest`, and the previous
 * release exactly as the real registry describes it. A machine on the previous release asks `npm view` for the latest and
 * gets the candidate; installing it fetches the tarball from the fake. `previous` is the real packument's version entry.
 */
export function cliPackument({ name, candidate, tarball, tarballUrl, previous }) {
	const versions = {
		[candidate.version]: {
			...candidate,
			dist: {
				tarball: tarballUrl,
				shasum: createHash("sha1").update(tarball).digest("hex"),
				integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
			},
		},
	};
	if (previous) versions[previous.version] = previous;
	return { name, "dist-tags": { latest: candidate.version }, versions };
}

/** What the fake platform recorded, reduced to the questions the smoke test asks. */
export function observed(requests) {
	const registrations = requests.filter((r) => r.method === "POST" && /^\/v1\/instances\/[^/]+\/runtime$/.test(r.path));
	const heartbeats = requests.filter((r) => r.method === "POST" && /^\/v1\/instances\/[^/]+\/runtime\/heartbeat$/.test(r.path));
	return {
		/** The CLI versions that registered, in order. */
		versions: registrations.map((r) => r.body?.runnerVersion).filter((v) => typeof v === "string"),
		registrations,
		heartbeats,
		/** A heartbeat that arrived after the n-th request overall. */
		heartbeatAfter: (index) => heartbeats.some((h) => h.seq > index),
	};
}

/** Registration of `version`, then a heartbeat after it: the runner started AND is alive. Returns what is missing, or null. */
export function missingForVersion(requests, version) {
	const obs = observed(requests);
	const reg = obs.registrations.find((r) => r.body?.runnerVersion === version);
	if (!reg) return `no runtime registration from ${version} (saw: ${obs.versions.join(", ") || "none"})`;
	if (!obs.heartbeatAfter(reg.seq)) return `${version} registered but has not heartbeated`;
	return null;
}
