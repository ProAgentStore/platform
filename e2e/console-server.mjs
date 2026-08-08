import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { execSync } from "node:child_process";
import { newestMtimeUnder, sdkDistVerdict } from "./build-inputs.mjs";

const port = Number(process.env.E2E_PORT || 4273);
const storeRoot = resolve("store");
const consoleDir = join(storeRoot, "console");
const adminDir = join(storeRoot, "admin");
const sdkDir = resolve("packages", "sdk");

/**
 * The SDK's `dist` is an INPUT to both app builds, and it is the one input this server does
 * not build itself (#413).
 *
 * `packages/sdk` resolves through `dist` — its `exports` map points every subpath at
 * `./dist/*.js` — so the console and admin bundles compile against whatever was last emitted
 * there. CI has a named `Build SDK` step before `pnpm test:e2e`; locally there is no such
 * step, which is the same CI/local divergence this ticket is about, one layer down.
 *
 * It REPORTS instead of building, unlike the app bundles below, because `dist` is shared:
 * `pnpm typecheck` writes it, `pnpm test` reads it, and several full suites run on this repo
 * at once (see the starvation note in `vitest.config.ts`). A `tsc` fired from inside a
 * Playwright webServer would truncate-and-rewrite files another process is importing.
 *
 * Both failure modes are worth naming, because only one of them is loud:
 *   - MISSING → rolldown dies with a 15-line stack trace about an unresolved bare specifier,
 *     which reads as a broken test rather than a missing build step (measured, 2026-08-08).
 *   - STALE → the build SUCCEEDS against yesterday's SDK. Nothing says anything.
 */
function requireBuiltSdk() {
	const verdict = sdkDistVerdict({
		entryExists: existsSync(join(sdkDir, "dist", "index.js")),
		newestDistMtime: newestMtimeUnder(join(sdkDir, "dist")),
		newestSrcMtime: newestMtimeUnder(join(sdkDir, "src")),
	});
	if (verdict === "ok") return;
	console.error(
		`\n✗ packages/sdk/dist is ${verdict}, and both store apps compile against it.\n` +
			`  ${verdict === "stale" ? "The bundles would build GREEN against the previous SDK." : "The bundle build will die in rolldown on an unresolved import."}\n\n` +
			"  Run:  pnpm --filter @proagentstore/sdk build\n\n" +
			"  (CI does this in its own `Build SDK` step before `pnpm test:e2e`. This server does\n" +
			"   not run it for you: dist is shared with `pnpm test` and `pnpm typecheck`, and\n" +
			"   rewriting it under a concurrent suite is worse than stopping here.)\n",
	);
	process.exit(1);
}

/**
 * Build a store SPA on demand and return the same single-file HTML shell that build.js
 * emits in production (bundle + CSS inlined).
 *
 * The admin app was added here for #283. It is a cheap passenger — ~70 modules, no SDK
 * and no coder-web, so its build is a fraction of the console's — which is what made
 * covering the destructive operator flows affordable in a repo where Playwright is the
 * heaviest thing running (#253, #274).
 */
function buildShell(dir, { title, description, name }) {
	const distDir = join(dir, "dist");
	// ALWAYS build. There is no staleness predicate here any more, and its absence is the fix
	// for #413 rather than a simplification of it.
	//
	// WHY THE PREDICATE WAS DELETED. It compared the bundle's mtime against the newest file
	// under this app's own `src` — and the console's sources are not all under `store/console`.
	// `agents/coder/web` is a separate workspace package whose TypeScript Vite compiles straight
	// into this bundle (its `exports` point at `./src/index.ts`, not at a dist), and
	// `packages/sdk` is another. So a commit touching only the Coder UI bumped nothing the walk
	// could see, the previous bundle was reused, and `pnpm test:e2e` ran today's specs against
	// yesterday's UI: the three specs #405 added failed locally on `main` and were green in CI on
	// the same SHA. Widening the root set fixes the two edges that exist TODAY; the next
	// `workspace:*` dependency added to `store/console/package.json` reopens the hole silently,
	// and no test can catch an omitted root, because a test can only assert the roots you listed.
	//
	// WHY ALWAYS-BUILDING IS AFFORDABLE, measured rather than assumed (2026-08-08, this repo,
	// Vite 8 / rolldown, `npx vite build` wall clock including node startup):
	//
	//     console  cold (dist removed) 0.42s   warm 0.60 / 0.41 / 0.43s
	//     admin    cold (dist removed) 0.32s   warm 0.34 / 0.33 / 0.34s
	//
	// ~0.75s for both, against a Playwright run measured in minutes. #413 named exactly this
	// trade — "if a warm-cache no-op `vite build` is under ~2s, it is the simplest correct
	// answer and this whole predicate can be deleted. Measure before choosing." — and 0.75 is
	// the answer that measurement gave. The old rejection ("a single-spec debug loop would pay a
	// full Vite build every time") was written against a slower bundler than the one now in the
	// lockfile.
	//
	// The property this buys is stronger than a wider walk: the local path is now the CI path.
	// CI checks out with no `dist` at all and therefore already builds unconditionally, which is
	// precisely why the hole was invisible from the CI side and cost an afternoon from the other.
	console.log(`Building ${name} React app for e2e tests...`);
	execSync("npx vite build", { cwd: dir, stdio: "inherit" });
	const bundleJs = readFileSync(join(distDir, "assets", "bundle.js"), "utf-8");
	const bundleCss = readFileSync(join(distDir, "assets", "index.css"), "utf-8");
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>${title}</title>
  <meta name="description" content="${description}">
  <meta name="theme-color" content="#7c3aed">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="manifest" href="/manifest.json">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,700&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${bundleCss}</style>
</head>
<body>
  <div id="root"></div>
  <script type="module">${bundleJs}</script>
</body>
</html>`;
}

requireBuiltSdk();

const consoleHtml = buildShell(consoleDir, {
	name: "console",
	title: "Creator Console — ProAgentStore",
	description: "Manage your server-powered AI agents on ProAgentStore.",
});

const adminHtml = buildShell(adminDir, {
	name: "admin",
	title: "Operator — ProAgentStore",
	description: "Operator portal for ProAgentStore.",
});

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
	// Admin: same deal — the operator SPA routes client-side under basename="/admin".
	if (cleanPath === "/admin" || cleanPath.startsWith("/admin/")) {
		return { type: "admin" };
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

	if (resolved.type === "console" || resolved.type === "admin") {
		res.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "public, max-age=300",
		});
		res.end(resolved.type === "admin" ? adminHtml : consoleHtml);
		return;
	}

	const file = resolved.path;
	if (!file || !existsSync(file) || !statSync(file).isFile()) {
		// store/docs is generated and not committed (see .gitignore), so a fresh
		// checkout that has not run the docs build has no /docs/* at all. Say which
		// command is missing — a bare 404 here reads as a broken test.
		const body = url.pathname.startsWith("/docs/")
			? "store/docs is build output and is missing. Run `pnpm docs:build` first (CI does, before test:e2e)."
			: "Not found";
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end(body);
		return;
	}

	res.writeHead(200, {
		"Content-Type": contentTypes[extname(file)] || "application/octet-stream",
	});
	createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => {
	console.log(`Console e2e server listening on http://127.0.0.1:${port}`);
});
