#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const docsDir = path.resolve("store/docs");
const textExtensions = new Set([".html", ".json", ".js", ".css", ".xml", ".txt"]);
const textNames = new Set(["LICENSE"]);

function walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const filePath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			walk(filePath);
			continue;
		}
		if (!entry.isFile()) continue;

		const ext = path.extname(entry.name);
		if (!textExtensions.has(ext) && !textNames.has(entry.name)) continue;

		const before = fs.readFileSync(filePath, "utf8");
		const after = before.replace(/[ \t]+$/gm, "");
		if (after !== before) fs.writeFileSync(filePath, after);
	}
}

if (fs.existsSync(docsDir)) walk(docsDir);
