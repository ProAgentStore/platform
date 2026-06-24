import { copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Seed a dedicated profile directory with a copy of the user's real Chrome
 * profile — cookies, logins, history, local storage. This gives the runner the
 * user's signed-in sessions and a human browsing reputation WITHOUT attaching to
 * the live profile, so it never fights Chrome's single-instance lock and the
 * user can keep their normal Chrome open. Seeds once; delete the dir to refresh.
 * Returns the seeded user-data-dir, or null if the source profile is unreadable.
 */
export function seedProfileCopy(real: { userDataDir: string; profile: string }, destUserDataDir: string): string | null {
	if (existsSync(destUserDataDir)) return destUserDataDir; // already seeded
	const srcProfile = join(real.userDataDir, real.profile);
	if (!existsSync(srcProfile)) return null;
	const destProfile = join(destUserDataDir, "Default");
	mkdirSync(destProfile, { recursive: true });
	try {
		// "Local State" holds the os_crypt key (Keychain-wrapped) that decrypts
		// cookies + saved passwords — without it the copied cookies are unreadable.
		copyFileSync(join(real.userDataDir, "Local State"), join(destUserDataDir, "Local State"));
	} catch {
		// best-effort
	}
	const items = [
		"Cookies",
		"Cookies-journal",
		"Login Data",
		"Login Data-journal",
		"Web Data",
		"History",
		"Preferences",
		"Bookmarks",
		"Favicons",
		"Network",
		"Local Storage",
		"Session Storage",
		"Sessions",
		"IndexedDB",
	];
	for (const item of items) {
		try {
			cpSync(join(srcProfile, item), join(destProfile, item), { recursive: true });
		} catch {
			// best-effort per item
		}
	}
	return destUserDataDir;
}

/**
 * Resolve the user's real Chrome profile when real-profile mode is enabled
 * (PAGS_RUNNER_REAL_PROFILE=1 or an explicit PAGS_RUNNER_CHROME_USER_DATA_DIR),
 * so the runner reuses their cookies/logins/history. Returns null otherwise.
 */
export function resolveRealChromeProfileDir(): { userDataDir: string; profile: string } | null {
	const explicit = process.env.PAGS_RUNNER_CHROME_USER_DATA_DIR;
	if (process.env.PAGS_RUNNER_REAL_PROFILE !== "1" && !explicit) return null;
	const expand = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);
	const profile = process.env.PAGS_RUNNER_CHROME_PROFILE || "Default";
	if (explicit) return { userDataDir: expand(explicit), profile };
	let userDataDir: string;
	if (process.platform === "darwin") {
		userDataDir = join(homedir(), "Library", "Application Support", "Google", "Chrome");
	} else if (process.platform === "win32") {
		userDataDir = join(homedir(), "AppData", "Local", "Google", "Chrome", "User Data");
	} else {
		userDataDir = join(homedir(), ".config", "google-chrome");
	}
	return existsSync(userDataDir) ? { userDataDir, profile } : null;
}
