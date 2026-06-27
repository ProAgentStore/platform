import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { execSync } from "node:child_process";

const port = Number(process.env.E2E_PORT || 4273);
const storeRoot = resolve("store");
const consoleDir = join(storeRoot, "console");

// Build the React console if dist doesn't exist yet
const distDir = join(consoleDir, "dist");
if (!existsSync(join(distDir, "assets", "bundle.js"))) {
	console.log("Building console React app for e2e tests...");
	execSync("npx vite build", { cwd: consoleDir, stdio: "inherit" });
}

// Generate the same HTML shell that build.js produces (bundle + CSS inlined)
const consoleBundleJs = readFileSync(join(distDir, "assets", "bundle.js"), "utf-8");
const consoleBundleCss = readFileSync(join(distDir, "assets", "index.css"), "utf-8");
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

const contentTypes = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".txt": "text/plain; charset=utf-8",
	".webp": "image/webp",
	".yaml": "text/yaml; charset=utf-8",
	".yml": "text/yaml; charset=utf-8",
};

function resolveStorePath(pathname) {
	const cleanPath = decodeURIComponent(pathname).replace(/\/+$/, "") || "/";

	// Bare root → redirect to /console/ (mirrors production host worker behavior)
	if (cleanPath === "" || cleanPath === "/") {
		return { type: "redirect", location: "/console/" };
	}
	// Console: serve the React SPA shell for all /console/* routes
	if (cleanPath === "/console" || cleanPath.startsWith("/console/")) {
		return { type: "console" };
	}
	if (cleanPath === "/docs/browser-runtime") {
		return { type: "file", path: join(storeRoot, "docs", "browser-runtime", "index.html") };
	}
	if (/^\/agents\/[a-z0-9-]+$/.test(cleanPath)) {
		return { type: "file", path: join(storeRoot, "agents", "detail.html") };
	}

	const relative = normalize(cleanPath.replace(/^\/+/, ""));
	const target = resolve(storeRoot, relative);
	if (!target.startsWith(storeRoot)) return null;

	if (existsSync(target) && statSync(target).isDirectory()) {
		return { type: "file", path: join(target, "index.html") };
	}
	return { type: "file", path: target };
}

createServer((req, res) => {
	const url = new URL(req.url || "/", "http://127.0.0.1");
	const resolved = resolveStorePath(url.pathname);

	if (!resolved) {
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Not found");
		return;
	}

	if (resolved.type === "redirect") {
		res.writeHead(302, { Location: resolved.location });
		res.end();
		return;
	}

	if (resolved.type === "console") {
		res.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "public, max-age=300",
		});
		res.end(consoleHtml);
		return;
	}

	const file = resolved.path;
	if (!file || !existsSync(file) || !statSync(file).isFile()) {
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Not found");
		return;
	}

	res.writeHead(200, {
		"Content-Type": contentTypes[extname(file)] || "application/octet-stream",
	});
	createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => {
	console.log(`Console e2e server listening on http://127.0.0.1:${port}`);
});
