import { describe, expect, it } from "vitest";
import worker from "./index";
import { docsFiles } from "./pages.test-stub";
import { publishedDocumentationPaths } from "./seo";

const origin = "https://proagentstore.online";
const files = {
	"/docs/sitemap.xml": btoa(`<urlset>${["/docs/", "/docs/windows/", "/docs/windows/", "/docs/missing/", "/docs/?alias=1", "/docs/#alias", "/console/", "https://other.example/docs/"].map(path => `<url><loc>${path.startsWith("https:") ? path : origin + path}</loc></url>`).join("")}</urlset>`),
	"/docs/index.html": btoa("Public overview"),
	"/docs/windows/index.html": btoa("Public Windows guide"),
	"/docs/unlisted/index.html": btoa("Not declared in the public docs sitemap"),
	"/console/index.html": btoa("Operator shell"),
};

describe("generated public documentation discovery", () => {
	it("includes declared built canonical docs once and excludes missing, external and alias locations", () => {
		expect(publishedDocumentationPaths(files)).toEqual(["/docs/", "/docs/windows/"]);
		expect(publishedDocumentationPaths({})).toEqual([]);
	});

	it("expands the actual host sitemap alongside published agents, without operator or undeclared pages", async () => {
		Object.assign(docsFiles, files);
		try {
			const response = await worker.fetch(new Request(`${origin}/sitemap.xml`), { API: { fetch: async () => Response.json({ agents: [{ slug: "one" }] }) } } as never);
			const xml = await response.text();
			expect(xml).toContain(`${origin}/docs/windows/`);
			expect(xml.match(/<loc>https:\/\/proagentstore.online\/docs\/<\/loc>/g)).toHaveLength(1);
			expect(xml).toContain(`${origin}/agents/one/`);
			for (const path of ["/console/", "/docs/unlisted/", "/docs/missing/", "other.example", "?alias", "#alias"]) expect(xml).not.toContain(path);
		} finally {
			for (const path of Object.keys(files)) delete docsFiles[path];
		}
	});
});
