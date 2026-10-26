/**
 * A working folder as the OWNER writes it, resolved on THE MACHINE it runs on (#1379).
 *
 * A folder used to be stored as the absolute path of the machine it was added from (`/Users/serge/dev/stores/pas/apps/hiring`).
 * Moved to a machine with another user name, the clone failed on a parent folder that machine could not create. The stored value is now
 * home-relative (`~/dev/stores/pas/apps/hiring`) and every machine expands it against ITS OWN home folder, on its own separators.
 *
 *   tilde          `~`, `~/x`, `~\x`     → under this machine's home
 *   relative       `dev/x`, `.\dev\x`    → under this machine's home (a bare relative path means "from home", never "from wherever the runner started")
 *   foreign-home   `/Users/serge/x`, `/home/serge/x`, `C:\Users\serge\x` when that user's home does not exist HERE → the same path under THIS home.
 *                  An absolute path of another account was how rows were stored before this; it is carried over, not refused.
 *   absolute       anything else, as written
 *
 * Pure but for the `exists` probe, which a test replaces. `how` is the debugging trail the cloud stores beside the resolved path.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export type WorkdirVia = "tilde" | "relative" | "foreign-home" | "absolute";

export interface HomePathOpts {
	home?: string;
	platform?: NodeJS.Platform;
	exists?: (p: string) => boolean;
}

export interface ResolvedWorkdir {
	requested: string;
	path: string;
	via: WorkdirVia;
}

const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** `/Users/<name>/<rest>`, `/home/<name>/<rest>`, `C:\Users\<name>\<rest>` → the account folder and the rest. */
const FOREIGN = /^(?:(\/(?:Users|home)\/[^/]+)(?:\/(.*))?|([A-Za-z]:[\\/]Users[\\/][^\\/]+)(?:[\\/](.*))?)$/;

export function resolveHomePath(raw: string, opts: HomePathOpts = {}): ResolvedWorkdir {
	const platform = opts.platform ?? process.platform;
	const home = opts.home ?? homedir();
	const exists = opts.exists ?? existsSync;
	const p = pathFor(platform);
	const requested = raw;
	const text = raw.trim();
	const under = (rest: string): string => p.resolve(home, ...rest.split(/[\\/]+/).filter(Boolean));

	if (text === "~") return { requested, path: p.resolve(home), via: "tilde" };
	const tilde = /^~[\\/](.*)$/.exec(text);
	if (tilde) return { requested, path: under(tilde[1]), via: "tilde" };

	const absolute = /^(?:[\\/]|[A-Za-z]:[\\/]|\\\\)/.test(text);
	if (!absolute) return { requested, path: under(text), via: "relative" };

	const foreign = FOREIGN.exec(text);
	if (foreign) {
		const account = foreign[1] ?? foreign[3];
		const rest = foreign[2] ?? foreign[4] ?? "";
		const here = p.resolve(home);
		const sameHome = p.resolve(account) === here || (platform === "win32" && p.resolve(account).toLowerCase() === here.toLowerCase());
		if (!sameHome && !exists(account)) return { requested, path: under(rest), via: "foreign-home" };
	}
	return { requested, path: p.resolve(text), via: "absolute" };
}

/** The home-relative spelling of `abs` on this machine (`~/dev/x`, always `/`), or null when it is not under the home folder. */
export function homeRelative(abs: string, opts: Pick<HomePathOpts, "home" | "platform"> = {}): string | null {
	const platform = opts.platform ?? process.platform;
	const p = pathFor(platform);
	const home = p.resolve(opts.home ?? homedir());
	const rel = p.relative(home, p.resolve(abs));
	if (rel === "") return "~";
	if (rel.startsWith("..") || p.isAbsolute(rel)) return null;
	return `~/${rel.split(/[\\/]+/).join("/")}`;
}
