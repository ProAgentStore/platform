const DEFAULT_ACCOUNTS_BASE = "https://accounts.zoho.com";
const DEFAULT_API_BASE = "https://www.zohoapis.com/workdrive";
const DEFAULT_DOWNLOAD_BASE = "https://download.zoho.com";

export const WORKDRIVE_SCOPE = [
	"aaaserver.profile.READ",
	"WorkDrive.files.READ",
	"WorkDrive.teamfolders.READ",
	"ZohoFiles.files.READ",
].join(",");

export interface WorkDriveEnv {
	ZOHO_CLIENT_ID?: string;
	ZOHO_CLIENT_SECRET?: string;
	ZOHO_ACCOUNTS_BASE?: string;
	ZOHO_WORKDRIVE_API_BASE?: string;
	ZOHO_WORKDRIVE_DOWNLOAD_BASE?: string;
}

export class WorkDriveError extends Error {}

export interface WorkDriveFile {
	id: string;
	name: string;
	type: string;
	isFolder: boolean;
	mimeType?: string;
	extension?: string;
	permalink?: string;
	modifiedTime?: string;
}

export interface WorkDriveFolderPage {
	files: WorkDriveFile[];
	offset: number;
	limit: number;
	nextOffset: number | null;
	hasMore: boolean;
}

export interface WorkDriveExportedFile {
	id: string;
	name: string;
	mimeType?: string;
	permalink?: string;
	text: string;
}

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

export function workDriveAccountsBase(env: WorkDriveEnv): string {
	return trimTrailingSlash(env.ZOHO_ACCOUNTS_BASE || DEFAULT_ACCOUNTS_BASE);
}

function workDriveApiBase(env: WorkDriveEnv): string {
	return trimTrailingSlash(env.ZOHO_WORKDRIVE_API_BASE || DEFAULT_API_BASE);
}

function workDriveDownloadBase(env: WorkDriveEnv): string {
	return trimTrailingSlash(env.ZOHO_WORKDRIVE_DOWNLOAD_BASE || DEFAULT_DOWNLOAD_BASE);
}

export async function mintWorkDriveAccessToken(
	env: WorkDriveEnv,
	refreshToken: string,
): Promise<string> {
	if (!env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET) {
		throw new WorkDriveError("Zoho WorkDrive OAuth is not configured on this deployment");
	}
	const res = await fetch(`${workDriveAccountsBase(env)}/oauth/v2/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: env.ZOHO_CLIENT_ID,
			client_secret: env.ZOHO_CLIENT_SECRET,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}),
	});
	if (!res.ok) {
		throw new WorkDriveError(
			`Could not refresh Zoho WorkDrive access (${res.status}). Reconnect Zoho WorkDrive in settings.`,
		);
	}
	const data = (await res.json()) as { access_token?: string };
	if (!data.access_token) throw new WorkDriveError("Zoho did not return an access token");
	return data.access_token;
}

export function workDriveResourceIdFromUrl(input: string): string | null {
	const raw = input.trim();
	if (!raw) return null;
	if (/^[a-zA-Z0-9_-]{10,}$/.test(raw) && !raw.includes("/")) return raw;
	try {
		const url = new URL(raw);
		const queryId =
			url.searchParams.get("resource_id") ||
			url.searchParams.get("file_id") ||
			url.searchParams.get("folder_id") ||
			url.searchParams.get("id");
		if (queryId) return queryId;
		const patterns = [
			/\/files\/([^/?#]+)/,
			/\/file\/([^/?#]+)/,
			/\/folder\/([^/?#]+)/,
			/\/folders\/([^/?#]+)/,
			/\/ws\/([^/?#]+)/,
			/\/workdrive\/download\/([^/?#]+)/,
			/\/download\/([^/?#]+)/,
		];
		for (const pattern of patterns) {
			const match = url.pathname.match(pattern);
			if (match?.[1] && match[1] !== "files") return match[1];
		}
		return null;
	} catch {
		return null;
	}
}

async function workDriveFetch(env: WorkDriveEnv, accessToken: string, path: string): Promise<Response> {
	return fetch(`${workDriveApiBase(env)}${path}`, {
		headers: {
			Accept: "application/vnd.api+json",
			Authorization: `Zoho-oauthtoken ${accessToken}`,
		},
	});
}

async function parseWorkDriveFiles(res: Response, opts: { defaultFolder?: boolean } = {}): Promise<WorkDriveFile[]> {
	const data = (await res.json()) as { data?: Array<{ id?: string; type?: string; attributes?: Record<string, unknown> }> };
	return (data.data ?? []).map((item) => normalizeFile(item, opts)).filter((f): f is WorkDriveFile => !!f);
}

async function workDriveDownloadFetch(env: WorkDriveEnv, accessToken: string, resourceId: string): Promise<Response> {
	return fetch(`${workDriveDownloadBase(env)}/v1/workdrive/download/${encodeURIComponent(resourceId)}`, {
		headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
	});
}

async function workDriveErrorReason(res: Response): Promise<string> {
	try {
		const raw = await res.text();
		try {
			const j = JSON.parse(raw) as { errors?: Array<{ title?: string }>; error?: string; message?: string };
			if (j.errors?.[0]?.title) return j.errors[0].title;
			return j.message || j.error || raw.slice(0, 200);
		} catch {
			return raw.slice(0, 200) || "no error body";
		}
	} catch {
		return "unreadable error body";
	}
}

function attrString(attrs: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = attrs[key];
		if (typeof value === "string" && value) return value;
	}
	return undefined;
}

function normalizeFile(
	item: { id?: string; type?: string; attributes?: Record<string, unknown> },
	opts: { defaultFolder?: boolean } = {},
): WorkDriveFile | null {
	const id = item.id;
	if (!id) return null;
	const a = item.attributes ?? {};
	const name = String(a.name || a.filename || a.display_name || id);
	const type = String(item.type || a.type || "files");
	const semanticType = [
		type,
		attrString(a, ["type", "resource_type", "resourceType", "category", "file_type", "fileType"]),
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
	return {
		id,
		name,
		type,
		isFolder: opts.defaultFolder === true || /\bfolders?\b/.test(semanticType),
		mimeType: attrString(a, ["mime_type", "mimeType"]),
		extension: attrString(a, ["extn", "extension"]),
		permalink: attrString(a, ["permalink"]),
		modifiedTime: attrString(a, ["modified_time", "modifiedTime"]),
	};
}

function normalizePage(opts: { limit?: number; offset?: number } = {}): { limit: number; offset: number } {
	const limit = Math.max(1, Math.min(Math.trunc(opts.limit ?? 50) || 50, 50));
	const offset = Math.max(0, Math.trunc(opts.offset ?? 0) || 0);
	return { limit, offset };
}

export async function listWorkDriveFolder(
	env: WorkDriveEnv,
	accessToken: string,
	folderIdOrUrl: string,
	opts: { limit?: number; offset?: number } = {},
): Promise<WorkDriveFolderPage> {
	const folderId = workDriveResourceIdFromUrl(folderIdOrUrl);
	if (!folderId) throw new WorkDriveError("Zoho WorkDrive folder id or URL required");
	const { limit, offset } = normalizePage(opts);
	const params = new URLSearchParams({
		"page[limit]": String(limit),
		"page[offset]": String(offset),
		"filter[type]": "allfiles",
	});
	const filesRes = await workDriveFetch(env, accessToken, `/api/v1/files/${encodeURIComponent(folderId)}/files?${params}`);
	if (filesRes.ok) {
		const files = await parseWorkDriveFiles(filesRes);
		return {
			files,
			offset,
			limit,
			nextOffset: files.length === limit ? offset + limit : null,
			hasMore: files.length === limit,
		};
	}

	const filesReason = await workDriveErrorReason(filesRes);
	const teamFolderRes = await workDriveFetch(env, accessToken, `/api/v1/teamfolders/${encodeURIComponent(folderId)}/folders?${params}`);
	if (teamFolderRes.ok) {
		const files = await parseWorkDriveFiles(teamFolderRes, { defaultFolder: true });
		return {
			files,
			offset,
			limit,
			nextOffset: files.length === limit ? offset + limit : null,
			hasMore: files.length === limit,
		};
	}
	throw new WorkDriveError(`Zoho WorkDrive folder list failed (${filesRes.status}): ${filesReason}`);
}

export async function getWorkDriveFile(
	env: WorkDriveEnv,
	accessToken: string,
	resourceIdOrUrl: string,
): Promise<WorkDriveFile> {
	const resourceId = workDriveResourceIdFromUrl(resourceIdOrUrl);
	if (!resourceId) throw new WorkDriveError("Zoho WorkDrive file id or URL required");
	const res = await workDriveFetch(env, accessToken, `/api/v1/files/${encodeURIComponent(resourceId)}`);
	if (!res.ok) throw new WorkDriveError(`Zoho WorkDrive file lookup failed (${res.status}): ${await workDriveErrorReason(res)}`);
	const data = (await res.json()) as { data?: { id?: string; type?: string; attributes?: Record<string, unknown> } };
	const file = data.data ? normalizeFile(data.data) : null;
	if (!file) throw new WorkDriveError("Zoho WorkDrive did not return file metadata");
	return file;
}

function isTextLike(contentType: string, name: string): boolean {
	const ct = contentType.toLowerCase();
	const ext = name.toLowerCase().split(".").pop() || "";
	return (
		ct.startsWith("text/") ||
		ct.includes("json") ||
		ct.includes("xml") ||
		["txt", "md", "csv", "json", "xml", "html", "htm", "yaml", "yml", "tsv"].includes(ext)
	);
}

export async function exportWorkDriveFile(
	env: WorkDriveEnv,
	accessToken: string,
	resourceIdOrUrl: string,
): Promise<WorkDriveExportedFile> {
	const resourceId = workDriveResourceIdFromUrl(resourceIdOrUrl);
	if (!resourceId) throw new WorkDriveError("Zoho WorkDrive file id or URL required");
	const meta = await getWorkDriveFile(env, accessToken, resourceId);
	const res = await workDriveDownloadFetch(env, accessToken, resourceId);
	if (!res.ok) throw new WorkDriveError(`Zoho WorkDrive download failed (${res.status}): ${await workDriveErrorReason(res)}`);
	const contentType = res.headers.get("content-type") || meta.mimeType || "";
	if (!isTextLike(contentType, meta.name)) {
		throw new WorkDriveError(`Unsupported WorkDrive file type for text import: ${contentType || meta.extension || "unknown"}`);
	}
	let text = await res.text();
	if (text.length > 90_000) text = `${text.slice(0, 90_000)}\n...[truncated]`;
	return {
		id: meta.id,
		name: meta.name,
		mimeType: contentType || meta.mimeType,
		permalink: meta.permalink,
		text,
	};
}
