import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The build this bundle reports on every client error row (#539) — the console's rule. Without it the
// admin SPA reported `build: "unset"`, indistinguishable from any other build-less caller (#1120).
const BUILD_ID = (process.env.GITHUB_SHA || "").slice(0, 12) || "dev";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	define: { __BUILD__: JSON.stringify(BUILD_ID) },
	base: "/admin/",
	build: {
		outDir: "dist",
		rollupOptions: {
			input: "index.vite.html",
			output: {
				// Stable filenames so build.js can find them (mirrors the console app).
				entryFileNames: "assets/bundle.js",
				assetFileNames: "assets/[name][extname]",
			},
		},
	},
	server: {
		proxy: {
			"/admin/api": {
				target: "https://api.proagentstore.online",
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/admin\/api/, ""),
			},
		},
	},
});
