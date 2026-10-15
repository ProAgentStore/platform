import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Site sign-in sessions for the Application Runner (#1094).
 *
 * A fill run against SEEK pressed "Quick apply", which opens SEEK's form only for a signed-in
 * user. In a browser with no SEEK session the press bounced to `login.seek.com`, and because that
 * press is treated as a possible one-click send (#994/#1013) the run had to end
 * `submit_unconfirmed` — so nothing was ever submitted, run after run.
 *
 * The fix has two halves. The browser profile an application run drives now PERSISTS on this
 * machine (`live-run-browser.ts`), so a sign-in survives between runs. And this ledger lets a run
 * know, BEFORE the uncertain press, whether that profile is signed in to the site: if it is not, the
 * run pauses `login_required` — the owner signs in once in that same browser through the existing
 * handoff — instead of pressing into a sign-in wall.
 *
 * ## What is stored, and what is not
 *
 * One JSON file per browser profile: for each site, whether it needs a sign-in, when one was last
 * completed, the login host it bounced to (a hostname), and the NAMES and expiry of the cookies that
 * appeared when the owner signed in (the "fingerprint"). Never a cookie value, a password, a URL
 * query, or anything typed. The session itself lives only in the browser profile, as it would in
 * the owner's own browser.
 *
 * ## What a check can and cannot prove
 *
 * A check reads the profile's cookies for the site: if any fingerprint cookie is gone or expired,
 * the session is treated as missing and the owner is asked to sign in again. It cannot see a session
 * the SITE revoked while the cookie is still present; that case still presses, lands on a sign-in
 * page and ends `submit_unconfirmed` as before (#1013's rule) — and is learned here, so the NEXT run
 * asks for a sign-in first. A sign-in the owner completed without any new cookie appearing (they
 * were already signed in) is recorded as `verifiable: false`: later checks pass and rely on that
 * same learning.
 */

export interface SessionCookie {
	name: string;
	domain: string;
	/** Seconds since the epoch; -1 for a browser-session cookie. */
	expires: number;
}

/** Cookie access for the run's own browser profile. Names and expiry are all this module reads. */
export type CookieReader = () => Promise<SessionCookie[]>;

export interface SiteSessionEntry {
	/** The site key: a registrable domain such as `seek.com`. */
	site: string;
	state: "sign_in_needed" | "signed_in";
	/** Why the ledger knows this site needs a sign-in. */
	basis: "bounced_to_sign_in" | "owner_signed_in";
	loginHost?: string;
	cookieNames?: string[];
	verifiable?: boolean;
	signedInAt?: string;
	updatedAt: string;
}

export interface SiteSessionLedgerFile {
	version: 1;
	sites: Record<string, SiteSessionEntry>;
}

export type SessionCheck =
	| { state: "ok"; site: string | null }
	| { state: "missing"; site: string; reason: "never_signed_in" | "expired" | "bounced_to_sign_in" };

/**
 * Sites whose one-click apply only works for a signed-in user. SEEK is listed from the verified
 * failure in #1094 (two fill runs, two machines, both bounced to `login.seek.com`). A site not listed
 * here joins the ledger the first time a press bounces to its sign-in page.
 */
export const SIGN_IN_REQUIRED_SITES: readonly string[] = ["seek.com", "seek.com.au", "seek.co.nz"];

const SECOND_LEVEL = new Set(["com", "co", "net", "org", "gov", "edu", "ac", "id"]);

/** `au.seek.com` → `seek.com`; `www.seek.com.au` → `seek.com.au`. Good enough for a site key, not a PSL. */
export function siteKeyOf(host: string): string {
	const labels = host.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
	if (labels.length <= 2) return labels.join(".");
	const tld = labels[labels.length - 1];
	const sld = labels[labels.length - 2];
	return labels.slice(tld.length === 2 && SECOND_LEVEL.has(sld) ? -3 : -2).join(".");
}

/** Does this page look like a sign-in page? A password field, or a login/SSO host or path. */
export function looksLikeSignIn(url: string, hasPassword: boolean): boolean {
	if (hasPassword) return true;
	try {
		const u = new URL(url);
		return /^(login|signin|sign-in|auth|accounts?|sso|id)\./i.test(u.hostname) || /\/(login|log-in|signin|sign-in|oauth2?|authorize)(\/|$)/i.test(u.pathname);
	} catch {
		return false;
	}
}

function cookieSite(c: SessionCookie): string {
	return siteKeyOf(c.domain.replace(/^\./, ""));
}

function live(c: SessionCookie, nowMs: number): boolean {
	return c.expires === -1 || c.expires * 1000 > nowMs;
}

export class SiteSessionLedger {
	private file: SiteSessionLedgerFile;
	/** Cookie names (with expiry) seen per site when a sign-in pause began, to diff on resume. */
	private before = new Map<string, Map<string, number>>();

	constructor(
		private readonly path: string,
		private readonly cookies: CookieReader,
		private readonly now: () => number = Date.now,
	) {
		this.file = SiteSessionLedger.read(path);
	}

	static read(path: string): SiteSessionLedgerFile {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as SiteSessionLedgerFile;
			if (parsed && parsed.version === 1 && parsed.sites && typeof parsed.sites === "object") return parsed;
		} catch {
			// Missing or unreadable: start empty. The worst case is one extra sign-in prompt.
		}
		return { version: 1, sites: {} };
	}

	entries(): SiteSessionEntry[] {
		return Object.values(this.file.sites);
	}

	/** Is this profile signed in to the site that `url` is on, as far as can be shown? */
	async check(url: string): Promise<SessionCheck> {
		const host = hostname(url);
		if (!host) return { state: "ok", site: null };
		const site = siteKeyOf(host);
		const entry = this.file.sites[site];
		if (!entry) return SIGN_IN_REQUIRED_SITES.includes(site) ? { state: "missing", site, reason: "never_signed_in" } : { state: "ok", site: null };
		if (entry.state === "sign_in_needed") return { state: "missing", site, reason: entry.basis === "bounced_to_sign_in" ? "bounced_to_sign_in" : "never_signed_in" };
		if (!entry.verifiable || !entry.cookieNames?.length) return { state: "ok", site };
		const now = this.now();
		const present = new Set((await this.cookies()).filter((c) => cookieSite(c) === site && live(c, now)).map((c) => c.name));
		return entry.cookieNames.every((n) => present.has(n)) ? { state: "ok", site } : { state: "missing", site, reason: "expired" };
	}

	/** A sign-in pause is starting for `site`: remember which of its cookies exist now. */
	async beginSignIn(site: string): Promise<void> {
		const now = this.now();
		const seen = new Map<string, number>();
		for (const c of await this.cookies()) if (cookieSite(c) === site && live(c, now)) seen.set(c.name, c.expires);
		this.before.set(site, seen);
	}

	/** The owner resumed after signing in: record the cookies that appeared or were renewed. Names only. */
	async completeSignIn(site: string): Promise<{ fingerprint: number; verifiable: boolean }> {
		const before = this.before.get(site) ?? new Map<string, number>();
		this.before.delete(site);
		const now = this.now();
		const names = (await this.cookies())
			.filter((c) => cookieSite(c) === site && live(c, now) && (!before.has(c.name) || before.get(c.name) !== c.expires))
			.map((c) => c.name);
		const cookieNames = [...new Set(names)].sort().slice(0, 50);
		const at = new Date(now).toISOString();
		const prior = this.file.sites[site];
		this.file.sites[site] = {
			site,
			state: "signed_in",
			basis: "owner_signed_in",
			...(prior?.loginHost ? { loginHost: prior.loginHost } : {}),
			cookieNames,
			verifiable: cookieNames.length > 0,
			signedInAt: at,
			updatedAt: at,
		};
		this.save();
		return { fingerprint: cookieNames.length, verifiable: cookieNames.length > 0 };
	}

	/** A press on `fromUrl` landed on a sign-in page: the next run must ask for a sign-in first. */
	learnSignInWall(fromUrl: string, signInUrl: string): string | null {
		const from = hostname(fromUrl);
		if (!from) return null;
		const site = siteKeyOf(from);
		const at = new Date(this.now()).toISOString();
		const loginHost = hostname(signInUrl) ?? undefined;
		this.file.sites[site] = { site, state: "sign_in_needed", basis: "bounced_to_sign_in", ...(loginHost ? { loginHost } : {}), updatedAt: at };
		this.save();
		return site;
	}

	private save(): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const tmp = `${this.path}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(this.file, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, this.path);
	}
}

function hostname(url: string): string | null {
	try {
		const u = new URL(url);
		return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : null;
	} catch {
		return null;
	}
}
