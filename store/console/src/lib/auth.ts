import { api, getToken, setToken } from "@proagentstore/sdk/client";

export interface User {
	id: string;
	login: string;
	avatar: string;
	display_name?: string;
	bio?: string;
	website?: string;
	twitter?: string;
	slack_webhook?: string;
	roles?: string[];
	boardConfig?: BoardConfig;
}

export interface BoardConfig {
	summary: string;
	columns: BoardColumn[];
}

export interface BoardColumn {
	id: string;
	title: string;
	color: string;
	empty: string;
	statuses?: string[];
	visibilities?: string[];
	excludeStatuses?: string[];
	excludeVisibilities?: string[];
	catchAll?: boolean;
}

export async function signIn(provider: "google" | "github" = "github") {
	const res = await fetch("https://api.proagentstore.online/v1/auth/config");
	const config = await res.json();
	const returnTo = encodeURIComponent(window.location.href);
	const oauthUrl =
		provider === "google" ? config.google_oauth_url : config.oauth_url;
	window.location.href = `${oauthUrl}?app_id=${config.app_id}&response_mode=${config.response_mode}&return_to=${returnTo}`;
}

export async function handleOAuthCallback(): Promise<string | null> {
	const params = new URLSearchParams(window.location.search);
	const fasSession = params.get("fas_session");
	if (!fasSession) return null;

	try {
		const res = await api<{ token?: string; user?: User }>(
			"/v1/auth/exchange",
			{ method: "POST", body: JSON.stringify({ fas_session: fasSession }) },
			true,
		);
		if (res.token) {
			setToken(res.token);
			window.history.replaceState({}, "", window.location.pathname);
			return res.token;
		}
	} catch (e) {
		console.error("OAuth exchange error:", e);
	}
	window.history.replaceState({}, "", window.location.pathname);
	return null;
}

export async function checkAuth(): Promise<User | null> {
	const token = getToken();
	if (!token) return null;
	try {
		const data = await api<User>("/v1/auth/me");
		if (data.id) return data;
	} catch {
		setToken(null);
	}
	return null;
}

export function signOut() {
	setToken(null);
}

export { getToken, setToken };
