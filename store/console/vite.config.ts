import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * The build id baked into the bundle (#539).
 *
 * CI sets `GITHUB_SHA` for every step, so a deployed bundle carries the commit it was built from,
 * short-form. Off CI there is no sha and the honest answer is `dev` — NOT an empty string and not
 * a fabricated id, because a value that looks like a build but resolves to nothing is worse than
 * one that plainly says "a developer's machine". Every client error row carries this, which is how
 * a never-reloaded tab running pre-fix JavaScript is told apart from a fix that did not work.
 */
const BUILD_ID = (process.env.GITHUB_SHA || "").slice(0, 12) || "dev";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	base: "/console/",
	define: { __BUILD__: JSON.stringify(BUILD_ID) },
	build: {
		outDir: "dist",
		rollupOptions: {
			input: "index.vite.html",
			output: {
				// Stable filenames so build.js can find them
				entryFileNames: "assets/bundle.js",
				assetFileNames: "assets/[name][extname]",
			},
		},
	},
	server: {
		proxy: {
			"/v1": "https://api.proagentstore.online",
		},
	},
});
