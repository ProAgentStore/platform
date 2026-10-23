import { homedir, userInfo } from "node:os";
import { configDir } from "./runner-lock.js";
import type { ServiceContext } from "./service-install.js";

/** This machine and this CLI, as the service installers need them (#1141, #1320). */
export function serviceContext(): ServiceContext {
	const user = (() => {
		try {
			return userInfo().username;
		} catch {
			return process.env.USER || process.env.USERNAME || undefined; // no passwd entry (containers): fall back to the env
		}
	})();
	return {
		platform: process.platform,
		home: homedir(),
		nodePath: process.execPath,
		script: process.argv[1],
		configDir: configDir(),
		pathEnv: process.env.PATH ?? "",
		uid: process.getuid?.(),
		user,
		domain: process.env.USERDOMAIN,
	};
}
