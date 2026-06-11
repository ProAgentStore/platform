import fs from "node:fs";
import path from "node:path";
import type { CheckResult } from "../types.js";

const MAX_DESCRIPTION_LEN = 200;
const MAX_NAME_LEN = 50;

export async function checkMetadata(dir: string): Promise<CheckResult[]> {
	const manifestPath = path.join(dir, "agent.json");
	if (!fs.existsSync(manifestPath)) {
		// manifest-exists check is handled by checkManifest; skip here
		return [];
	}

	let manifest: Record<string, unknown>;
	try {
		manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
	} catch {
		return [];
	}

	const results: CheckResult[] = [];

	// description not empty
	const description = String(manifest.description ?? "");
	results.push({
		name: "metadata-description-not-empty",
		pass: description.trim().length > 0,
		message:
			description.trim().length > 0 ? "Description is set" : "description must not be empty",
		severity: "error",
	});

	// description under 200 chars
	results.push({
		name: "metadata-description-length",
		pass: description.length <= MAX_DESCRIPTION_LEN,
		message:
			description.length <= MAX_DESCRIPTION_LEN
				? `Description is ${description.length} chars`
				: `Description is ${description.length} chars (max ${MAX_DESCRIPTION_LEN})`,
		severity: "warning",
	});

	// name under 50 chars
	const name = String(manifest.name ?? "");
	results.push({
		name: "metadata-name-length",
		pass: name.length > 0 && name.length <= MAX_NAME_LEN,
		message:
			name.length > 0 && name.length <= MAX_NAME_LEN
				? `Name is ${name.length} chars`
				: name.length === 0
					? "name must not be empty"
					: `Name is ${name.length} chars (max ${MAX_NAME_LEN})`,
		severity: "warning",
	});

	return results;
}
