#!/usr/bin/env node
/** Reads store HTML files and writes them into src/pages.ts as exported strings. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const storeDir = path.join(__dirname, "..", "..", "store");

// ── Console: React app built by Vite ────────────────────────────
// The Vite build outputs: dist/assets/bundle.js + dist/assets/index.css
// We generate a minimal HTML shell that loads them inline.
const consoleDir = path.join(storeDir, "console");
const consoleBundleJs = fs.readFileSync(
	path.join(consoleDir, "dist", "assets", "bundle.js"),
	"utf-8",
);
const consoleBundleCss = fs.readFileSync(
	path.join(consoleDir, "dist", "assets", "index.css"),
	"utf-8",
);

// Read the old index.html for the <head> metadata, then replace its body
// with the React mount point + inline bundle.
const consoleHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Creator Console — ProAgentStore</title>
  <meta name="description" content="Manage your server-powered AI agents on ProAgentStore.">
  <meta name="theme-color" content="#7c3aed">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="manifest" href="/manifest.json">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,700&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${consoleBundleCss}</style>
</head>
<body>
  <div id="root"></div>
  <script type="module">${consoleBundleJs}</script>
</body>
</html>`;

function walkFiles(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkFiles(fullPath));
		} else if (entry.isFile()) {
			out.push(fullPath);
		}
	}
	return out;
}

function docsFileMap(docsDir) {
	const files = {};
	for (const filePath of walkFiles(docsDir)) {
		const relative = path.relative(docsDir, filePath).replaceAll(path.sep, "/");
		files[`/docs/${relative}`] = fs.readFileSync(filePath).toString("base64");
	}
	return files;
}

const docsFiles = docsFileMap(path.join(storeDir, "docs"));

// ── Other pages ─────────────────────────────────────────────────
const pages = {
	homepage: fs.readFileSync(path.join(storeDir, "index.html"), "utf-8"),
	aboutPage: fs.readFileSync(
		path.join(storeDir, "about", "index.html"),
		"utf-8",
	),
	getStartedPage: fs.readFileSync(
		path.join(storeDir, "get-started", "index.html"),
		"utf-8",
	),
	skillsPage: fs.readFileSync(
		path.join(storeDir, "skills", "index.html"),
		"utf-8",
	),
	skillMcpOperatorPage: fs.readFileSync(
		path.join(storeDir, "skills", "proagentstore-mcp-operator", "index.html"),
		"utf-8",
	),
	consolePage: consoleHtml,
	privacyPage: fs.readFileSync(
		path.join(storeDir, "app", "privacy", "index.html"),
		"utf-8",
	),
	termsPage: fs.readFileSync(
		path.join(storeDir, "app", "terms", "index.html"),
		"utf-8",
	),
	supportPage: fs.readFileSync(
		path.join(storeDir, "app", "support", "index.html"),
		"utf-8",
	),
	deletePage: fs.readFileSync(
		path.join(storeDir, "app", "delete", "index.html"),
		"utf-8",
	),
	agentDetailPage: fs.readFileSync(
		path.join(storeDir, "agents", "detail.html"),
		"utf-8",
	),
	widgetJs: fs.readFileSync(path.join(storeDir, "widget.js"), "utf-8"),
	authWidgetJs: fs.readFileSync(path.join(storeDir, "auth-widget.js"), "utf-8"),
	swJs: fs.readFileSync(path.join(storeDir, "sw.js"), "utf-8"),
	adminPage: fs.readFileSync(path.join(storeDir, "admin", "index.html"), "utf-8"),
	notFoundPage: fs.readFileSync(path.join(storeDir, "404.html"), "utf-8"),
	changelogPage: fs.readFileSync(path.join(storeDir, "changelog", "index.html"), "utf-8"),
	openapiYaml: fs.readFileSync(path.join(storeDir, "openapi.yaml"), "utf-8"),
	llmsTxt: fs.readFileSync(path.join(storeDir, "llms.txt"), "utf-8"),
	llmsFullTxt: fs.readFileSync(path.join(storeDir, "llms-full.txt"), "utf-8"),
	skillsJson: fs.readFileSync(path.join(storeDir, "skills.json"), "utf-8"),
	mcpServerJson: fs.readFileSync(path.join(storeDir, ".well-known", "mcp-server.json"), "utf-8"),
	developerProfilePage: fs.readFileSync(
		path.join(storeDir, "developers", "profile.html"),
		"utf-8",
	),
};

// Binary assets (base64 encoded)
const brandDir = path.join(__dirname, "..", "..", "brand", "assets");
const binaries = {};
for (const size of [16, 32, 48, 64, 128, 180, 192, 512]) {
	const p = path.join(brandDir, `icon-${size}.png`);
	if (fs.existsSync(p)) binaries[`icon${size}`] = fs.readFileSync(p).toString("base64");
}
const ogPath = path.join(brandDir, "og-image.png");
if (fs.existsSync(ogPath)) binaries.ogImage = fs.readFileSync(ogPath).toString("base64");
const faviconSvg = fs.existsSync(path.join(brandDir, "favicon.svg"))
	? fs.readFileSync(path.join(brandDir, "favicon.svg"), "utf-8") : "";
const manifestJson = fs.readFileSync(path.join(storeDir, "manifest.json"), "utf-8");

let out = "// Auto-generated by build.js — do not edit manually\n";
for (const [name, html] of Object.entries(pages)) {
	out += `export const ${name} = ${JSON.stringify(html)};\n`;
}
out += `export const docsFiles: Record<string, string> = ${JSON.stringify(docsFiles)};\n`;
out += `export const faviconSvg = ${JSON.stringify(faviconSvg)};\n`;
out += `export const manifestJson = ${JSON.stringify(manifestJson)};\n`;
for (const [name, b64] of Object.entries(binaries)) {
	out += `export const ${name} = "${b64}";\n`;
}

fs.writeFileSync(path.join(__dirname, "src", "pages.ts"), out);
console.log("Generated src/pages.ts with", Object.keys(pages).length, "pages +", Object.keys(binaries).length, "assets");
