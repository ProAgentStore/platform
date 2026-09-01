import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
	plugins: [react(), tailwindcss()],
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
