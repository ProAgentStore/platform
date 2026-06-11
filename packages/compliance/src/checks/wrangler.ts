import fs from "node:fs";
import path from "node:path";
import type { CheckResult } from "../types.js";

export async function checkWrangler(dir: string): Promise<CheckResult[]> {
	const wranglerPath = path.join(dir, "wrangler.toml");

	if (!fs.existsSync(wranglerPath)) {
		return [
			{
				name: "wrangler-exists",
				pass: false,
				message: "Missing wrangler.toml",
				severity: "error",
			},
		];
	}

	const content = fs.readFileSync(wranglerPath, "utf-8");
	const results: CheckResult[] = [
		{
			name: "wrangler-exists",
			pass: true,
			message: "Found",
			severity: "info",
		},
	];

	// name field
	const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
	const hasName = nameMatch !== null && nameMatch[1].trim().length > 0;
	results.push({
		name: "wrangler-name",
		pass: hasName,
		message: hasName ? `name = "${nameMatch[1]}"` : "Missing or empty name field in wrangler.toml",
		severity: "error",
	});

	// routes — either [[routes]] section or a routes pattern
	const hasRoutes =
		content.includes("[[routes]]") || content.includes("[routes]") || /pattern\s*=/.test(content);
	results.push({
		name: "wrangler-routes",
		pass: hasRoutes,
		message: hasRoutes
			? "Routes configured"
			: "No routes defined in wrangler.toml — agent must have a route",
		severity: "error",
	});

	return results;
}
