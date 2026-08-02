import { hostname } from "node:os";
import { loadSession } from "../login.js";
import type {
	PagsRequestOptions,
	RunnerRequestOptions,
	RuntimeRegisterOptions,
} from "./types.js";

export function clean(value?: string): string | undefined {
	const trimmed = value?.trim();
	return trimmed || undefined;
}

export function runnerBaseUrl(url?: string): string {
	return (clean(url) || clean(process.env.PAGS_RUNNER_URL) || "http://127.0.0.1:49171").replace(/\/$/, "");
}

export function pagsApiBase(url?: string): string {
	return (clean(url) || clean(process.env.PAGS_API_BASE) || "https://api.proagentstore.online").replace(/\/$/, "");
}

export function pagsHeaders(token?: string): Record<string, string> {
	// Fall back to the saved login (pags login) so `runner connect` works without
	// PAGS_TOKEN — same token `pags up` uses.
	const resolved = clean(token) || clean(process.env.PAGS_TOKEN) || clean(loadSession()?.token);
	return resolved ? { Authorization: `Bearer ${resolved}` } : {};
}

export function runnerHeaders(token?: string): Record<string, string> {
	const resolved = clean(token) || clean(process.env.PAGS_RUNNER_TOKEN);
	return resolved ? { Authorization: `Bearer ${resolved}` } : {};
}

export function runnerRequestHeaders(opts: RunnerRequestOptions): Record<string, string> {
	const resolved = clean(opts.token) || clean(process.env.PAGS_RUNNER_TOKEN);
	const headers: Record<string, string> = resolved ? { Authorization: `Bearer ${resolved}` } : {};
	const instanceId = clean(opts.instanceId) || clean(process.env.PAGS_INSTANCE_ID);
	if (instanceId) headers["X-PAGS-Instance-Id"] = instanceId;
	return headers;
}

export function apiPathSegment(value: string): string {
	return encodeURIComponent(value);
}

export function buildRuntimeRegistrationBody(opts: RuntimeRegisterOptions, capabilities: string[] = []) {
	return {
		endpointUrl: clean(opts.endpointUrl) || opts.endpointUrl,
		token: clean(opts.runnerToken) || clean(opts.token) || clean(process.env.PAGS_RUNNER_TOKEN),
		placement: opts.placement === "managed" ? "managed" : "local",
		capabilities,
		runnerVersion: clean(opts.runnerVersion) || "",
		runnerNode: hostname(),
	};
}

export async function requestRunner<T>(
	method: string,
	path: string,
	opts: RunnerRequestOptions,
	body?: unknown,
): Promise<T> {
	const headers: Record<string, string> = {
		...runnerRequestHeaders(opts),
	};
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const res = await fetch(`${runnerBaseUrl(opts.url)}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const { text, data } = await readResponse(res);
	if (!res.ok) {
		const message = responseErrorMessage(data, text, res.statusText);
		throw new Error(`${res.status} ${message}`);
	}
	return data as T;
}

export async function requestPags<T>(
	method: string,
	path: string,
	opts: PagsRequestOptions,
	body?: unknown,
): Promise<T> {
	const headers: Record<string, string> = {
		...pagsHeaders(opts.pagsToken),
	};
	if (!headers.Authorization) {
		throw new Error("PAGS token required. Set PAGS_TOKEN or pass --pags-token.");
	}
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const res = await fetch(`${pagsApiBase(opts.apiBase)}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const { text, data } = await readResponse(res);
	if (!res.ok) {
		const message = responseErrorMessage(data, text, res.statusText);
		throw new Error(`${res.status} ${message}`);
	}
	return data as T;
}

async function readResponse(res: Response): Promise<{ text: string; data: Record<string, unknown> }> {
	const text = await res.text();
	if (!text) return { text, data: {} };
	try {
		return { text, data: JSON.parse(text) as Record<string, unknown> };
	} catch {
		return { text, data: {} };
	}
}

function responseErrorMessage(
	data: Record<string, unknown>,
	text: string,
	statusText: string,
): string {
	return typeof data.error === "string" ? data.error : text || statusText;
}
