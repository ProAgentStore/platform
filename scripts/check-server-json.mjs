#!/usr/bin/env node
// CI guard (#1227): `server.json` fits the MCP registry's own schema limits, checked BEFORE publishing.
//
// The registry validates `server.json` against `server.schema.json` (`$schema` in the file). Its
// `ServerDetail` caps `description` and `title` at 100 characters each (2025-12-11 schema,
// `definitions.ServerDetail.properties.{description,title}.maxLength`). A manifest over either limit
// is refused at `mcp-publisher publish` — on `main`, after the version has already moved, as a red
// publish run. This catches it in CI, on the push that introduced it, naming the field, its length
// and the limit.
//
// Only `server.json` is checked because only `server.json` is published: the registry entry is a
// pointer to https://mcp.proagentstore.online/mcp, and no tool description is ever sent to it.
//
// Used by `.github/workflows/ci.yml` and `.github/workflows/publish-mcp-registry.yml`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The registry schema's limits for the fields this manifest sets. Re-read the schema when `$schema` moves. */
export const REGISTRY_LIMITS = { description: 100, title: 100 };

/** Every field over its limit, as `{ field, length, limit }`. Empty when the manifest fits. A missing field is not over. */
export function serverJsonProblems(manifest) {
	const out = [];
	for (const [field, limit] of Object.entries(REGISTRY_LIMITS)) {
		const value = manifest?.[field];
		if (typeof value === "string" && [...value].length > limit) out.push({ field, length: [...value].length, limit });
	}
	return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const path = process.argv[2] ?? "server.json";
	const manifest = JSON.parse(readFileSync(path, "utf8"));
	const problems = serverJsonProblems(manifest);
	if (problems.length) {
		for (const p of problems) console.error(`✗ ${path}: "${p.field}" is ${p.length} characters; the MCP registry allows at most ${p.limit} (server.schema.json). Shorten it before publishing.`);
		process.exit(1);
	}
	console.log(`✓ ${path} fits the MCP registry's limits: ${Object.entries(REGISTRY_LIMITS).map(([f, l]) => `${f} ${[...(manifest[f] ?? "")].length}/${l}`).join(", ")}.`);
}
