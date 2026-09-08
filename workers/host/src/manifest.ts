/**
 * The web-app manifest, optionally pinned to one instance (#784).
 *
 * `store/manifest.json` says `start_url: "/console/"`, and both Chrome and Safari read
 * `start_url` at INSTALL time and open it — not the page the user was on. So "Add to Home
 * Screen" from an instance page installed an icon that opened the instance list, which is the
 * exact trip #784 asks to remove. While the console shows an instance, its `<link rel="manifest">`
 * points here with `?start=<that instance's path>&name=<its name>`, and this returns the same
 * manifest with those two fields substituted.
 *
 * PURE and strict: the query is attacker-controlled input to a document browsers trust.
 *   · `start` must be a console instance path and nothing else — no scheme, no host, no `..`,
 *     no query of its own — so a manifest can never install an icon that opens somewhere off
 *     the console.
 *   · `name` is bounded, printable, and used only as a display string in JSON (serialised by
 *     `JSON.stringify`, never interpolated).
 * Anything that fails either check yields the DEFAULT manifest, byte-identical to before, so a
 * bad link degrades to "installs the console", never to an error page.
 *
 * Lives in its own module because `index.ts` imports the generated `pages.js` and cannot be
 * unit-tested without a build (see `cors.test.ts`); this can.
 */

/** `/console/instances/<id>` with an optional tab — the shape `lib/routes.ts` links at. */
const START_PATH = /^\/console\/instances\/[A-Za-z0-9._-]{1,64}(?:\/[a-z]{1,24})?$/;
const NAME_MAX = 30;
/** Control characters, including DEL — a display name is printable text or nothing. */
const CONTROL_CHARS = /\p{Cc}/gu;

export interface PinnedManifest {
	body: string;
	/** True when `start`/`name` were applied — the caller shortens the cache for these. */
	pinned: boolean;
}

/** A display name: bounded, and stripped of anything that is not printable text. */
export function sanitizeManifestName(raw: string | null): string | null {
	if (!raw) return null;
	const cleaned = raw.replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
	return cleaned.length ? cleaned : null;
}

export function pinnedManifest(base: string, query: URLSearchParams): PinnedManifest {
	const start = query.get("start");
	if (!start || !START_PATH.test(start)) return { body: base, pinned: false };
	let manifest: Record<string, unknown>;
	try {
		manifest = JSON.parse(base) as Record<string, unknown>;
	} catch {
		return { body: base, pinned: false };
	}
	const name = sanitizeManifestName(query.get("name"));
	const pinned: Record<string, unknown> = { ...manifest, start_url: start };
	if (name) {
		// Both names, so the home-screen label (short_name) and the install prompt (name) agree.
		pinned.short_name = name;
		pinned.name = `${name} — ProAgentStore`;
	}
	return { body: JSON.stringify(pinned, null, 2), pinned: true };
}
