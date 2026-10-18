/**
 * `pags login --device` — sign this machine in from any other device (#1157).
 *
 * `pags login` could only open a browser on the machine itself: over SSH, or on a headless box, it hung at
 * "Opening browser…" with nothing to open. On 18 Oct 2026 the Dell's session had expired and recovery needed
 * someone at its keyboard. The device flow (RFC 8628) needs no browser here: the machine shows a link and a short
 * code, the owner approves on a phone or laptop where they are signed in, and the machine's poll collects one
 * session. The API half is `workers/api/src/routes/device-auth.ts`.
 */

export type LoginFlow = "device" | "browser";

/**
 * Which sign-in to run. The flags win; otherwise the device flow wherever a browser here cannot be what the owner
 * sees: an SSH session (any OS — OpenSSH sets these on Windows too), or Linux with no X11/Wayland display.
 */
export function chooseLoginFlow(opts: { device?: boolean; browser?: boolean }, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { flow: LoginFlow; why: string } {
	if (opts.device) return { flow: "device", why: "--device" };
	if (opts.browser) return { flow: "browser", why: "--browser" };
	if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return { flow: "device", why: "this is an SSH session" };
	if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return { flow: "device", why: "there is no display here" };
	return { flow: "browser", why: "" };
}

/** When a PAGS session token expires, in ms — read from its own payload (`<b64url json>.<sig>`); null when unreadable. */
export function sessionExpiresAt(token: string): number | null {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
		return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
	} catch {
		return null;
	}
}

export interface DeviceLoginDeps {
	apiBase: string;
	/** This machine's name, shown on the approval page so the owner can tell it is theirs. */
	node: string;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	log: (line: string) => void;
}

interface Started {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete: string;
	expires_in: number;
	interval: number;
}

/** Run the device flow to its end: the approved session token, or a thrown reason (denied, expired). */
export async function deviceLogin(deps: DeviceLoginDeps): Promise<string> {
	const fetchFn = deps.fetch ?? fetch;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const now = deps.now ?? Date.now;
	const post = (path: string, body: unknown) => fetchFn(`${deps.apiBase}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

	const res = await post("/v1/auth/device/start", { node: deps.node });
	if (!res.ok) throw new Error(`Could not start a device sign-in (HTTP ${res.status}).`);
	const started = (await res.json()) as Started;
	deps.log("To sign this machine in, open this link on your phone or any device where you are signed in to ProAgentStore:");
	deps.log(`  ${started.verification_uri_complete}`);
	deps.log(`or go to ${started.verification_uri} and enter the code:  ${started.user_code}`);
	deps.log(`Check that the page shows this machine (${deps.node}) and this code. Waiting for approval — the code lasts ${Math.round(started.expires_in / 60)} minutes…`);

	let interval = Math.max(1, started.interval) * 1000;
	const deadline = now() + started.expires_in * 1000;
	while (now() < deadline) {
		await sleep(interval);
		let answer: { session?: string; error?: string };
		try {
			const r = await post("/v1/auth/device/token", { device_code: started.device_code });
			answer = (await r.json().catch(() => ({}))) as typeof answer;
			if (r.ok && answer.session) return answer.session;
		} catch {
			continue; // a network blip: keep polling until the code expires
		}
		if (answer.error === "slow_down") interval += 5_000; // RFC 8628 §3.5
		else if (answer.error === "access_denied") throw new Error("The sign-in was denied on the approval page.");
		else if (answer.error === "expired_token") break;
		// authorization_pending, or a server error: poll again
	}
	throw new Error("The code expired before it was approved. Run `pags login --device` again for a new one.");
}
