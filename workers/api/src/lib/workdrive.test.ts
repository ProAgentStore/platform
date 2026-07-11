import { afterEach, describe, expect, it, vi } from "vitest";
import {
	exportWorkDriveFile,
	listWorkDriveFolder,
	mintWorkDriveAccessToken,
	WORKDRIVE_SCOPE,
	workDriveFolderContainsFile,
	workDriveResourceIdFromUrl,
} from "./workdrive.js";

describe("workDriveResourceIdFromUrl", () => {
	it("accepts a raw WorkDrive resource id", () => {
		expect(workDriveResourceIdFromUrl("v310zf0b27cc29f5040c7bda64baaecca983a")).toBe(
			"v310zf0b27cc29f5040c7bda64baaecca983a",
		);
	});

	it("extracts ids from file, folder, and download URLs", () => {
		expect(workDriveResourceIdFromUrl("https://workdrive.zoho.com/file/l0ai97a15a3915de649969aae63b718da3bae")).toBe(
			"l0ai97a15a3915de649969aae63b718da3bae",
		);
		expect(workDriveResourceIdFromUrl("https://workdrive.zoho.com/home/team/privatespace/folders/folder123")).toBe("folder123");
		expect(workDriveResourceIdFromUrl("https://download.zoho.com/v1/workdrive/download/file456")).toBe("file456");
	});

	it("extracts team-folder ids from workspace URLs", () => {
		expect(workDriveResourceIdFromUrl("https://workdrive.zoho.com/home/team/teams/teamid/ws/ws123/folders/files")).toBe("ws123");
	});

	it("prefers direct file ids over parent folder ids in nested file URLs", () => {
		expect(workDriveResourceIdFromUrl("https://workdrive.zoho.com/home/team/teams/teamid/ws/ws123/folders/folder123/files/file456")).toBe("file456");
	});

	it("extracts ids from common query parameters", () => {
		expect(workDriveResourceIdFromUrl("https://workdrive.zoho.com/home?folder_id=folder789")).toBe("folder789");
		expect(workDriveResourceIdFromUrl("https://workdrive.zoho.com/home?file_id=file789")).toBe("file789");
		expect(workDriveResourceIdFromUrl("https://workdrive.zoho.com/home?resource_id=res789")).toBe("res789");
	});

	it("returns null for empty or invalid inputs", () => {
		expect(workDriveResourceIdFromUrl("")).toBeNull();
		expect(workDriveResourceIdFromUrl("not a url with spaces")).toBeNull();
	});
});

describe("WORKDRIVE_SCOPE", () => {
	it("requests file download and team-folder read scopes", () => {
		expect(WORKDRIVE_SCOPE.split(",")).toEqual([
			"aaaserver.profile.READ",
			"WorkDrive.files.READ",
			"WorkDrive.teamfolders.READ",
			"ZohoFiles.files.READ",
		]);
	});
});

describe("listWorkDriveFolder", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("falls back to the teamfolders endpoint for team-folder root ids", async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ title: "URL Rule is not configured" }] }), { status: 404 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({
				data: [
					{
						id: "file123456789",
						type: "files",
						attributes: { name: "notes.md", extn: "md", mime_type: "text/markdown" },
					},
				],
			}), { status: 200, headers: { "content-type": "application/vnd.api+json" } }));
		vi.stubGlobal("fetch", fetchMock);

		const page = await listWorkDriveFolder({}, "token", "teamfolder123456789");

		expect(page).toMatchObject({ offset: 0, limit: 50, nextOffset: null, hasMore: false });
		expect(page.files).toHaveLength(1);
		expect(page.files[0]).toMatchObject({
			id: "file123456789",
			name: "notes.md",
			type: "files",
			isFolder: true,
			extension: "md",
			mimeType: "text/markdown",
		});
		expect(fetchMock).toHaveBeenNthCalledWith(
			1,
			expect.stringContaining("/api/v1/files/teamfolder123456789/files?"),
			expect.any(Object),
		);
		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			expect.stringContaining("/api/v1/teamfolders/teamfolder123456789/folders?"),
			expect.any(Object),
		);
	});

	it("passes pagination params and reports the next offset when a page is full", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
			data: Array.from({ length: 2 }, (_, i) => ({
				id: `file${i}123456789`,
				type: "files",
				attributes: { name: `file-${i}.txt`, extn: "txt", mime_type: "text/plain" },
			})),
		}), { status: 200, headers: { "content-type": "application/vnd.api+json" } }));
		vi.stubGlobal("fetch", fetchMock);

		const page = await listWorkDriveFolder({}, "token", "folder123456789", { limit: 2, offset: 4 });

		expect(page).toMatchObject({ offset: 4, limit: 2, nextOffset: 6, hasMore: true });
		const url = String(fetchMock.mock.calls[0][0]);
		expect(url).toContain("page%5Blimit%5D=2");
		expect(url).toContain("page%5Boffset%5D=4");
	});
});

describe("workDriveFolderContainsFile", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("checks later pages when a granted folder has more than one page", async () => {
		const firstPage = Array.from({ length: 50 }, (_, i) => ({
			id: `file${i}123456789`,
			type: "files",
			attributes: { name: `file-${i}.txt`, extn: "txt", mime_type: "text/plain" },
		}));
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({ data: firstPage }), { status: 200, headers: { "content-type": "application/vnd.api+json" } }))
			.mockResolvedValueOnce(new Response(JSON.stringify({
				data: [
					{
						id: "target123456789",
						type: "files",
						attributes: { name: "target.txt", extn: "txt", mime_type: "text/plain" },
					},
				],
			}), { status: 200, headers: { "content-type": "application/vnd.api+json" } }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(workDriveFolderContainsFile({}, "token", "folder123456789", "target123456789")).resolves.toBe(true);
		expect(String(fetchMock.mock.calls[0][0])).toContain("page%5Boffset%5D=0");
		expect(String(fetchMock.mock.calls[1][0])).toContain("page%5Boffset%5D=50");
	});

	it("checks nested folders under a granted folder", async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({
				data: [
					{
						id: "childfolder123456789",
						type: "folders",
						attributes: { name: "Child folder" },
					},
				],
			}), { status: 200, headers: { "content-type": "application/vnd.api+json" } }))
			.mockResolvedValueOnce(new Response(JSON.stringify({
				data: [
					{
						id: "target123456789",
						type: "files",
						attributes: { name: "target.txt", extn: "txt", mime_type: "text/plain" },
					},
				],
			}), { status: 200, headers: { "content-type": "application/vnd.api+json" } }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(workDriveFolderContainsFile({}, "token", "rootfolder123456789", "target123456789")).resolves.toBe(true);
		expect(String(fetchMock.mock.calls[0][0])).toContain("/api/v1/files/rootfolder123456789/files?");
		expect(String(fetchMock.mock.calls[1][0])).toContain("/api/v1/files/childfolder123456789/files?");
	});

	it("returns false when a file is not under the granted folder", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
			data: [
				{
					id: "other123456789",
					type: "files",
					attributes: { name: "other.txt", extn: "txt", mime_type: "text/plain" },
				},
			],
		}), { status: 200, headers: { "content-type": "application/vnd.api+json" } }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(workDriveFolderContainsFile({}, "token", "rootfolder123456789", "target123456789")).resolves.toBe(false);
	});
});

describe("mintWorkDriveAccessToken", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("throws a reconnect error when token refresh fails", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("bad token", { status: 400 })));

		await expect(mintWorkDriveAccessToken({
			ZOHO_CLIENT_ID: "client",
			ZOHO_CLIENT_SECRET: "secret",
		}, "refresh")).rejects.toThrow("Reconnect Zoho WorkDrive");
	});
});

describe("exportWorkDriveFile", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("downloads text-like files", async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({
				data: {
					id: "file123456789",
					type: "files",
					attributes: { name: "notes.md", extn: "md", mime_type: "text/markdown", permalink: "https://workdrive.zoho.com/file/file123456789" },
				},
			}), { status: 200, headers: { "content-type": "application/vnd.api+json" } }))
			.mockResolvedValueOnce(new Response("# Notes", { status: 200, headers: { "content-type": "text/markdown" } }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(exportWorkDriveFile({}, "token", "file123456789")).resolves.toMatchObject({
			id: "file123456789",
			name: "notes.md",
			mimeType: "text/markdown",
			permalink: "https://workdrive.zoho.com/file/file123456789",
			text: "# Notes",
		});
	});

	it("rejects unsupported binary files", async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({
				data: {
					id: "file123456789",
					type: "files",
					attributes: { name: "scan.pdf", extn: "pdf", mime_type: "application/pdf" },
				},
			}), { status: 200, headers: { "content-type": "application/vnd.api+json" } }))
			.mockResolvedValueOnce(new Response("pdf bytes", { status: 200, headers: { "content-type": "application/pdf" } }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(exportWorkDriveFile({}, "token", "file123456789")).rejects.toThrow("Unsupported WorkDrive file type");
	});
});
