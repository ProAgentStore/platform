/** Create the scoped test resolver; Vite importer IDs use forward slashes on Windows too. */
export function createWorkerTestDeps({ apiEntry, hostIndex, hostPagesStub }) {
	const normalize = (id) => id?.replaceAll("\\", "/");
	return {
		name: "worker-test-deps",
		enforce: /** @type {const} */ ("pre"),
		async resolveId(source, importer) {
			const id = normalize(importer);
			if (source === "./pages.js" && id === normalize(hostIndex)) return hostPagesStub;
			if (source !== "hono" || !id?.includes("/templates/")) return null;
			return this.resolve(source, apiEntry, { skipSelf: true });
		},
	};
}
