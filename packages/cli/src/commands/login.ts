import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { writeLine, writeError } from "../output.js";

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

export function requireSession(): StoredSession {
	const session = loadSession();
	if (!session) {
		writeError("Not logged in. Run: pags login");
		process.exit(1);
	}
	return session;
}

export const loginCommand = new Command("login")
	.description("Sign in with Google or GitHub (opens browser)")
	.option("--github", "Use GitHub instead of Google")
	.action(async (opts: { github?: boolean }) => {
		const provider = opts.github ? "github" : "google";
		writeLine(`Opening browser for ${provider} sign-in...`);

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
					const meRes = await fetch(`${API_BASE}/v1/auth/me`, {
						headers: { Authorization: `Bearer ${session}` },
					});
					if (!meRes.ok) throw new Error("Session validation failed");
					const me = await meRes.json() as { id: string; login: string; avatar: string };

					saveSession({
						token: session,
						user: { id: me.id, login: me.login, avatar: me.avatar },
						expiresAt: Date.now() + 29 * 24 * 60 * 60 * 1000, // ~29 days
					});

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

		// Open browser
		const open = (await import("node:child_process")).exec;
		const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
		open(`${cmd} "${oauthUrl}"`);

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
		try {
			if (existsSync(TOKEN_FILE)) {
				const { unlinkSync } = require("node:fs") as typeof import("node:fs");
				unlinkSync(TOKEN_FILE);
			}
			writeLine("Signed out.");
		} catch { writeLine("Already signed out."); }
	});

export const whoamiCommand = new Command("whoami")
	.description("Show current signed-in user")
	.action(() => {
		const session = loadSession();
		if (session) {
			writeLine(`${session.user.login} (${session.user.id})`);
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
