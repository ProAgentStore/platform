import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { writeLine, writeError } from "../output.js";
import { chooseLoginFlow, deviceLogin, sessionExpiresAt } from "./login-device.js";
import { expiryLine, expiryWarning } from "../session-expiry.js";

const CONFIG_DIR = join(homedir(), ".config", "proagentstore");
const TOKEN_FILE = join(CONFIG_DIR, "session.json");
const API_BASE = "https://api.proagentstore.online";

export interface StoredSession {
	token: string;
	user: { id: string; login: string; avatar: string };
	expiresAt: number;
}

export function loadSession(): StoredSession | null {
	try {
		if (!existsSync(TOKEN_FILE)) return null;
		const data = JSON.parse(readFileSync(TOKEN_FILE, "utf-8")) as StoredSession;
		if (data.expiresAt < Date.now()) { writeLine("Session expired. Run: pags login"); return null; }
		return data;
	} catch { return null; }
}

export function saveSession(session: StoredSession): void {
	mkdirSync(CONFIG_DIR, { recursive: true });
	writeFileSync(TOKEN_FILE, JSON.stringify(session, null, 2));
}

/** Resolve who `token` signs in as and store it — the end of every sign-in, browser or device. */
async function storeSession(token: string): Promise<StoredSession> {
	const meRes = await fetch(`${API_BASE}/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
	if (!meRes.ok) throw new Error("Session validation failed");
	const me = (await meRes.json()) as { id: string; login: string; avatar: string };
	// The token's own expiry (#1157), not a guess at it: a refreshed or device-issued session says when it ends.
	const session = { token, user: { id: me.id, login: me.login, avatar: me.avatar }, expiresAt: sessionExpiresAt(token) ?? Date.now() + 29 * 24 * 3600_000 };
	saveSession(session);
	return session;
}

export function requireSession(): StoredSession {
	const session = loadSession();
	if (!session) {
		writeError("Not logged in. Run: pags login");
		process.exit(1);
	}
	return session;
}

/**
 * How to open `url` in the default browser: a program and its arguments, never a shell line (#1158).
 *
 * It was `exec(\`start "<url>"\`)` on Windows, and cmd's `start` takes its first quoted argument as the WINDOW
 * TITLE — so `pags login` opened an empty console titled with the URL instead of the browser (dell-laptop,
 * 0.4.150). Every OS also handed the URL to a shell, where `&`, `%` and `^` mean something. Windows now asks the
 * URL handler directly (`rundll32 url.dll,FileProtocolHandler`, what Go's and Rust's browser openers use): no cmd,
 * so no title argument and nothing in the URL to escape. (`start "" "<url>"` would not need `^&` either — inside
 * quotes cmd keeps a caret literally, so escaping it there would corrupt the query string.)
 */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
	if (platform === "win32") return { file: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
	return { file: platform === "darwin" ? "open" : "xdg-open", args: [url] };
}

/** Best-effort: a browser that does not open (no xdg-open, a headless box) is covered by the URL printed beside it. */
function openBrowser(url: string): void {
	const { file, args } = browserCommand(url);
	try {
		const child = spawn(file, args, { stdio: "ignore", detached: true, windowsHide: true });
		child.on("error", () => undefined);
		child.unref();
	} catch {
		// the printed URL is the fallback
	}
}

export const loginCommand = new Command("login")
	.description("Sign in with Google or GitHub — in a browser here, or approved from another device over SSH/headless")
	.option("--github", "Use GitHub instead of Google")
	.option("--device", "Sign in from another device: show a link and a code to approve on your phone (SSH, no display)")
	.option("--browser", "Open a browser on this machine, even over SSH")
	.action(async (opts: { github?: boolean; device?: boolean; browser?: boolean }) => {
		const choice = chooseLoginFlow(opts);
		if (choice.flow === "device") {
			if (choice.why !== "--device") writeLine(`Signing in from another device, because ${choice.why} (use --browser to open one here instead).`);
			try {
				const session = await storeSession(await deviceLogin({ apiBase: API_BASE, node: hostname(), log: writeLine }));
				writeLine(`Signed in as ${session.user.login}. Token stored at ${TOKEN_FILE}`);
			} catch (err) {
				writeError(err instanceof Error ? err.message : String(err));
				process.exit(1);
			}
			return;
		}
		const provider = opts.github ? "github" : "google";

		// Start local callback server
		const port = await findFreePort();
		const callbackUrl = `http://127.0.0.1:${port}/callback`;

		const tokenPromise = new Promise<string>((resolve, reject) => {
			const timeout = setTimeout(() => { server.close(); reject(new Error("Login timed out (60s)")); }, 60_000);
			const server = createServer(async (req, res) => {
				const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
				if (url.pathname !== "/callback") { res.writeHead(404); res.end(); return; }

				// PAGS's own OAuth redirects back with ?session=<PAGS JWT> directly.
				const session = url.searchParams.get("session");
				if (!session) {
					res.writeHead(400, { "Content-Type": "text/html" });
					res.end("<h1>Sign-in failed</h1><p>No session received.</p>");
					clearTimeout(timeout);
					server.close();
					reject(new Error("No session in callback"));
					return;
				}

				// Resolve the signed-in user with the PAGS session token.
				try {
					const me = (await storeSession(session)).user;

					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(`<h1>Signed in as ${me.login}</h1><p>You can close this tab and return to the terminal.</p><script>window.close()</script>`);
					clearTimeout(timeout);
					server.close();
					resolve(session);
				} catch (err) {
					res.writeHead(500, { "Content-Type": "text/html" });
					res.end(`<h1>Sign-in failed</h1><p>${err instanceof Error ? err.message : String(err)}</p>`);
					clearTimeout(timeout);
					server.close();
					reject(err);
				}
			});
			server.listen(port, "127.0.0.1");
		});

		// Build OAuth URL — ProAgentStore's own OAuth, no FAS dependency.
		const oauthBase = provider === "google"
			? `${API_BASE}/v1/auth/google/start`
			: `${API_BASE}/v1/auth/github/start`;
		const oauthUrl = `${oauthBase}?return_to=${encodeURIComponent(callbackUrl)}`;

		// Always printed, on every OS (#1158): when no browser opens, the owner can still paste it into one on this machine.
		writeLine(`Opening your browser for ${provider} sign-in. If it does not open, paste this URL into a browser on this machine:`);
		writeLine(`  ${oauthUrl}`);
		openBrowser(oauthUrl);

		try {
			await tokenPromise;
			const session = loadSession();
			writeLine(`Signed in as ${session?.user.login}. Token stored at ${TOKEN_FILE}`);
		} catch (err) {
			writeError(err instanceof Error ? err.message : String(err));
			process.exit(1);
		}
	});

export const logoutCommand = new Command("logout")
	.description("Sign out and remove stored session")
	.action(() => {
		// STATIC import. This package is ESM ("type":"module", tsup --format esm), so esbuild
		// rewrites a bare `require("node:fs")` into its `__require` shim, which throws
		// `Dynamic require of "fs" is not supported` at runtime. The catch below then printed
		// "Already signed out." while the 30-day account JWT stayed on disk — `pags whoami` still
		// named the user and `pags up` still connected. A sign-out that reports success and
		// removes nothing is the worst possible shape for this command.
		if (!existsSync(TOKEN_FILE)) {
			writeLine("Already signed out.");
			return;
		}
		try {
			unlinkSync(TOKEN_FILE);
			writeLine("Signed out.");
		} catch (err) {
			// Report the REAL reason (permissions, a read-only home) instead of claiming success.
			writeError(`Could not remove ${TOKEN_FILE}: ${err instanceof Error ? err.message : String(err)}`);
			process.exit(1);
		}
	});

export const whoamiCommand = new Command("whoami")
	.description("Show current signed-in user")
	.action(() => {
		const session = loadSession();
		if (session) {
			writeLine(`${session.user.login} (${session.user.id})`);
			// When this sign-in runs out, and a warning at 30, 7 and 1 days before (#1184).
			const until = sessionExpiresAt(session.token) ?? session.expiresAt;
			writeLine(expiryLine(until, Date.now()));
			const warning = expiryWarning(until, Date.now());
			if (warning) writeLine(warning);
		} else {
			writeLine("Not logged in. Run: pags login");
		}
	});

async function findFreePort(): Promise<number> {
	return new Promise((resolve) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			server.close(() => resolve(port));
		});
	});
}
