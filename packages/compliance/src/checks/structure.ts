import fs from "node:fs";
import path from "node:path";
import type { CheckResult } from "../index.js";

interface StructureCheck {
	name: string;
	relPath: string;
	severity: "error" | "warning";
	message: string;
}

const REQUIRED: StructureCheck[] = [
	{
		name: "structure-src-index",
		relPath: path.join("src", "index.ts"),
		severity: "error",
		message: "Missing src/index.ts entry point",
	},
	{
		name: "structure-package-json",
		relPath: "package.json",
		severity: "error",
		message: "Missing package.json",
	},
	{
		name: "structure-deploy-yml",
		relPath: path.join(".github", "workflows", "deploy.yml"),
		severity: "error",
		message: "Missing .github/workflows/deploy.yml",
	},
	{
		name: "structure-readme",
		relPath: "README.md",
		severity: "warning",
		message: "Missing README.md",
	},
];

export async function checkStructure(dir: string): Promise<CheckResult[]> {
	return REQUIRED.map(({ name, relPath, severity, message }) => {
		const exists = fs.existsSync(path.join(dir, relPath));
		return {
			name,
			pass: exists,
			message: exists ? `Found ${relPath}` : message,
			severity: exists ? ("info" as const) : severity,
		};
	});
}
