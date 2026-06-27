const API = "https://api.proagentstore.online";
const SESSION_KEY = "pags:session";

export function getToken(): string | null {
	return localStorage.getItem(SESSION_KEY);
}

export function setToken(t: string | null) {
	if (t) localStorage.setItem(SESSION_KEY, t);
	else localStorage.removeItem(SESSION_KEY);
}

export async function api<T = Record<string, unknown>>(
	path: string,
	opts: RequestInit = {},
	noAuth = false,
): Promise<T> {
	const token = getToken();
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...((opts.headers as Record<string, string>) || {}),
	};
	if (!noAuth && token) headers.Authorization = `Bearer ${token}`;
	const res = await fetch(`${API}${path}`, { ...opts, headers });
	const data = await res.json();
	if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
	return data as T;
}

export { API };
