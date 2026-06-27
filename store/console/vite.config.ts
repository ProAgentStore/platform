import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	base: "/console/",
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
