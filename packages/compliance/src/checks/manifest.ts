import fs from "node:fs";
import path from "node:path";
import type { CheckResult } from "../types.js";

const VALID_STORE_TYPES = ["agent", "tool", "worker"] as const;
const VALID_CATEGORIES = [
	"general",
	"productivity",
	"writing",
	"coding",
	"research",
	"data",
	"image",
	"audio",
	"video",
	"finance",
	"health",
	"education",
	"entertainment",
	"utility",
] as const;

const SLUG_RE = /^[a-z0-9-]+$/;

export async function checkManifest(dir: string): Promise<CheckResult[]> {
	const manifestPath = path.join(dir, "agent.json");

	if (!fs.existsSync(manifestPath)) {
		return [
			{
				name: "manifest-exists",
				pass: false,
				message: "Missing agent.json",
				severity: "error",
			},
		];
	}

	let manifest: Record<string, unknown>;
	try {
		manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
	} catch {
		return [
			{
				name: "manifest-exists",
				pass: false,
				message: "Invalid JSON in agent.json",
				severity: "error",
			},
		];
	}

	const results: CheckResult[] = [
		{ name: "manifest-exists", pass: true, message: "Found", severity: "info" },
	];

	// Required fields
	const required = ["id", "name", "description", "storeType", "category"];
	for (const field of required) {
		const present = field in manifest && manifest[field] !== "";
		results.push({
			name: `manifest-${field}`,
			pass: present,
			message: present ? String(manifest[field]) : `Missing required field: ${field}`,
			severity: "error",
		});
	}

	// storeType must be valid
	if ("storeType" in manifest) {
		const valid = (VALID_STORE_TYPES as readonly string[]).includes(String(manifest.storeType));
		results.push({
			name: "manifest-storeType-valid",
			pass: valid,
			message: valid
				? `storeType is "${manifest.storeType}"`
				: `Invalid storeType "${manifest.storeType}" — must be one of: ${VALID_STORE_TYPES.join(", ")}`,
			severity: "error",
		});
	}

	// category must be valid
	if ("category" in manifest) {
		const valid = (VALID_CATEGORIES as readonly string[]).includes(String(manifest.category));
		results.push({
			name: "manifest-category-valid",
			pass: valid,
			message: valid
				? `category is "${manifest.category}"`
				: `Invalid category "${manifest.category}" — must be one of: ${VALID_CATEGORIES.join(", ")}`,
			severity: "error",
		});
	}

	// id must be slug format
	if ("id" in manifest) {
		const slug = String(manifest.id);
		const valid = SLUG_RE.test(slug);
		results.push({
			name: "manifest-slug-format",
			pass: valid,
			message: valid
				? `slug "${slug}" is valid`
				: `id "${slug}" must be lowercase alphanumeric with hyphens only`,
			severity: "error",
		});
	}

	return results;
}
