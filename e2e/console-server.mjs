import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const port = Number(process.env.E2E_PORT || 4273);
const storeRoot = resolve("store");

const contentTypes = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".txt": "text/plain; charset=utf-8",
	".webp": "image/webp",
};

function resolveStorePath(pathname) {
	const cleanPath = decodeURIComponent(pathname).replace(/\/+$/, "") || "/";
	if (
		cleanPath === "/console.css" ||
		/^\/console-(core|instances|agent-data|profile|utils-init)\.js$/.test(cleanPath)
	) {
		return join(storeRoot, "console", cleanPath.slice(1));
	}
	if (cleanPath === "/" || cleanPath === "/console" || cleanPath.startsWith("/console/")) {
		return join(storeRoot, "console", "index.html");
	}
	if (cleanPath === "/docs/browser-runtime") {
		return join(storeRoot, "docs", "browser-runtime", "index.html");
	}
	if (/^\/agents\/[a-z0-9-]+$/.test(cleanPath)) {
		return join(storeRoot, "agents", "detail.html");
	}

	const relative = normalize(cleanPath.replace(/^\/+/, ""));
	const target = resolve(storeRoot, relative);
	if (!target.startsWith(storeRoot)) return null;

	if (existsSync(target) && statSync(target).isDirectory()) {
		return join(target, "index.html");
	}
	return target;
}

createServer((req, res) => {
	const url = new URL(req.url || "/", "http://127.0.0.1");
	const file = resolveStorePath(url.pathname);
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
