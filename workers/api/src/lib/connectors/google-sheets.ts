// Google Sheets connector (issue #89 — the "populate a list of hotels" case). The first
// oauth2 connector defined as a declarative MANIFEST (#143) driven by the generic OAuth2 handler
// (#147): connect once at /v1/connectors/google_sheets/oauth/start, and the Pilot/agent can read
// + append rows. Reuses the platform's existing Google OAuth client (GOOGLE_CLIENT_ID/SECRET) with
// the spreadsheets scope; the refresh token is stored under its OWN vault slot ("google_sheets"),
// separate from Drive. INERT until the Google OAuth app has the spreadsheets scope + the
// /v1/connectors/google_sheets/oauth/callback redirect registered (deployment), like Meta.
//
// Both tools go through the shared executeHttpRequest engine (SSRF guard + bearer auth minted from
// the stored refresh token). They use the `handler` escape hatch only to URL-encode the A1 range
// and to pass the row array as a structured body — the connector SHAPE (auth/tools/schema) is data.
import type { ToolDef, RegistryToolCtx } from "../tool-registry.js";
import { compileConnector, type ConnectorManifest } from "./manifest.js";
import type { Connector } from "./registry.js";
import { executeHttpRequest } from "./http.js";

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

/** Read a range of cells → returns the `values` (array of rows). */
const sheetsReadHandler: ToolDef["handler"] = async (ctx: RegistryToolCtx, input) => {
	const id = String(input.spreadsheetId || "").trim();
	const range = String(input.range || "").trim();
	if (!id || !range) return { content: "spreadsheetId and range (e.g. \"Sheet1!A1:D50\") are required.", success: false };
	return executeHttpRequest(
		ctx,
		{
			method: "GET",
			url: `${SHEETS_BASE}/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}`,
			responseMap: "values",
			auth: { mode: "bearer" },
		},
		{ connectorId: "google_sheets" },
	);
};

/** Append rows to the end of a range (USER_ENTERED so formulas/dates parse). */
const sheetsAppendHandler: ToolDef["handler"] = async (ctx: RegistryToolCtx, input) => {
	const id = String(input.spreadsheetId || "").trim();
	const range = String(input.range || "").trim();
	const rows = Array.isArray(input.rows) ? input.rows : null;
	if (!id || !range || !rows) return { content: "spreadsheetId, range, and rows (an array of row-arrays, e.g. [[\"name\",\"phone\"]]) are required.", success: false };
	return executeHttpRequest(
		ctx,
		{
			method: "POST",
			url: `${SHEETS_BASE}/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`,
			body: { values: rows },
			auth: { mode: "bearer" },
		},
		{ connectorId: "google_sheets" },
	);
};

export const GOOGLE_SHEETS_MANIFEST: ConnectorManifest = {
	id: "google_sheets",
	label: "Google Sheets",
	auth: {
		type: "oauth2",
		authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
		tokenUrl: "https://oauth2.googleapis.com/token",
		scopes: ["https://www.googleapis.com/auth/spreadsheets"],
		clientIdEnv: "GOOGLE_CLIENT_ID",
		secretEnv: "GOOGLE_CLIENT_SECRET",
	},
	tools: [
		{
			name: "sheets_read",
			scope: "read",
			description: "Read a range of cells from a Google Sheet. Returns the rows as an array of arrays. Give the spreadsheet id (from its URL) and an A1 range like \"Sheet1!A1:D50\".",
			handler: "sheets_read",
			params: {
				spreadsheetId: { type: "string", required: true, description: "The spreadsheet id from its URL (docs.google.com/spreadsheets/d/<ID>/edit)." },
				range: { type: "string", required: true, description: "A1 notation range, e.g. \"Sheet1!A1:D50\"." },
			},
		},
		{
			name: "sheets_append",
			scope: "write",
			description: "Append rows to the end of a Google Sheet range (e.g. add newly-found leads). WRITE — requires the google_sheets connector's write consent.",
			handler: "sheets_append",
			params: {
				spreadsheetId: { type: "string", required: true, description: "The spreadsheet id from its URL." },
				range: { type: "string", required: true, description: "A1 range whose table to append to, e.g. \"Sheet1!A:D\"." },
				rows: { type: "array", required: true, description: "Rows to append — an array of row-arrays, e.g. [[\"Noble Roasters\",\"Waterloo\",\"0491650017\"]]." },
			},
		},
	],
};

/** Compiled Connector — consumed by the registry exactly like any other connector. */
export const GOOGLE_SHEETS_CONNECTOR: Connector = compileConnector(GOOGLE_SHEETS_MANIFEST, {
	sheets_read: sheetsReadHandler,
	sheets_append: sheetsAppendHandler,
}).connector;
