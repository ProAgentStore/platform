const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

export interface DriveEnv {
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
}

export class DriveError extends Error {}

export interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	modifiedTime?: string;
	webViewLink?: string;
	size?: string;
}

export interface DriveExportedFile {
	id: string;
	name: string;
	mimeType: string;
	webViewLink?: string;
	text: string;
}

export async function mintDriveAccessToken(
	env: DriveEnv,
	refreshToken: string,
): Promise<string> {
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
		throw new DriveError("Google Drive OAuth is not configured on this deployment");
	}
	const res = await fetch(TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: env.GOOGLE_CLIENT_ID,
			client_secret: env.GOOGLE_CLIENT_SECRET,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}),
	});
	if (!res.ok) {
		throw new DriveError(
			`Could not refresh Google Drive access (${res.status}). Reconnect Google Drive in settings.`,
		);
	}
	const data = (await res.json()) as { access_token?: string };
	if (!data.access_token) throw new DriveError("Google Drive did not return an access token");
	return data.access_token;
}

export function driveFileIdFromUrl(input: string): string | null {
	const raw = input.trim();
	if (!raw) return null;
	if (/^[a-zA-Z0-9_-]{10,}$/.test(raw) && !raw.includes("/")) return raw;
	try {
		const url = new URL(raw);
		const patterns = [
			/\/document\/d\/([^/]+)/,
			/\/spreadsheets\/d\/([^/]+)/,
			/\/presentation\/d\/([^/]+)/,
			/\/file\/d\/([^/]+)/,
			/\/open\/([^/]+)/,
		];
		for (const pattern of patterns) {
			const match = url.pathname.match(pattern);
			if (match?.[1]) return match[1];
		}
		return url.searchParams.get("id");
	} catch {
		return null;
	}
}

async function driveFetch(accessToken: string, path: string): Promise<Response> {
	return fetch(`${DRIVE_API}${path}`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
}

async function driveErrorReason(res: Response): Promise<string> {
	try {
		const raw = await res.text();
		try {
			const j = JSON.parse(raw) as { error?: { message?: string; status?: string } | string; error_description?: string };
			const e = j.error;
			if (typeof e === "object" && e?.message) return e.message;
			if (typeof e === "string") return j.error_description || e;
		} catch {
			/* not JSON */
		}
		return raw.slice(0, 200) || "no error body";
	} catch {
		return "unreadable error body";
	}
}

function escapeDriveQuery(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export async function listDriveFiles(
	accessToken: string,
	opts: { query?: string; pageSize?: number } = {},
): Promise<DriveFile[]> {
	const pageSize = Math.max(1, Math.min(opts.pageSize ?? 20, 50));
	const q = opts.query?.trim();
	const clauses = ["trashed = false"];
	if (q) clauses.push(`name contains '${escapeDriveQuery(q)}'`);
	const params = new URLSearchParams({
		pageSize: String(pageSize),
		q: clauses.join(" and "),
		orderBy: "modifiedTime desc",
		fields: "files(id,name,mimeType,modifiedTime,webViewLink,size)",
		supportsAllDrives: "true",
		includeItemsFromAllDrives: "true",
	});
	const res = await driveFetch(accessToken, `/files?${params}`);
	if (!res.ok) throw new DriveError(`Google Drive list failed (${res.status}): ${await driveErrorReason(res)}`);
	const data = (await res.json()) as { files?: DriveFile[] };
	return data.files ?? [];
}

async function fileMetadata(accessToken: string, fileId: string): Promise<DriveFile> {
	const params = new URLSearchParams({
		fields: "id,name,mimeType,modifiedTime,webViewLink,size",
		supportsAllDrives: "true",
	});
	const res = await driveFetch(accessToken, `/files/${encodeURIComponent(fileId)}?${params}`);
	if (!res.ok) throw new DriveError(`Google Drive file lookup failed (${res.status}): ${await driveErrorReason(res)}`);
	return (await res.json()) as DriveFile;
}

function exportMimeType(mimeType: string): string | null {
	if (mimeType === "application/vnd.google-apps.document") return "text/plain";
	if (mimeType === "application/vnd.google-apps.spreadsheet") return "text/csv";
	if (mimeType === "application/vnd.google-apps.presentation") return "text/plain";
	return null;
}

function isDirectTextMime(mimeType: string): boolean {
	return (
		mimeType.startsWith("text/") ||
		mimeType === "application/json" ||
		mimeType === "application/xml" ||
		mimeType === "application/x-ndjson" ||
		mimeType === "application/yaml"
	);
}

export async function exportDriveFile(
	accessToken: string,
	fileIdOrUrl: string,
): Promise<DriveExportedFile> {
	const fileId = driveFileIdFromUrl(fileIdOrUrl);
	if (!fileId) throw new DriveError("Google Drive file id or URL required");
	const meta = await fileMetadata(accessToken, fileId);
	const exportedType = exportMimeType(meta.mimeType);
	let res: Response;
	if (exportedType) {
		const params = new URLSearchParams({ mimeType: exportedType });
		res = await driveFetch(accessToken, `/files/${encodeURIComponent(fileId)}/export?${params}`);
	} else if (isDirectTextMime(meta.mimeType)) {
		const params = new URLSearchParams({ alt: "media", supportsAllDrives: "true" });
		res = await driveFetch(accessToken, `/files/${encodeURIComponent(fileId)}?${params}`);
	} else {
		throw new DriveError(`Unsupported Drive file type for text import: ${meta.mimeType}`);
	}
	if (!res.ok) throw new DriveError(`Google Drive export failed (${res.status}): ${await driveErrorReason(res)}`);
	let text = await res.text();
	if (text.length > 90_000) text = `${text.slice(0, 90_000)}\n...[truncated]`;
	return {
		id: meta.id,
		name: meta.name,
		mimeType: meta.mimeType,
		webViewLink: meta.webViewLink,
		text,
	};
}
