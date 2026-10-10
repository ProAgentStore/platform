import { describe, expect, it } from "vitest";
import { knowledgeSubtabFromSearch, searchWithKnowledgeSubtab } from "./knowledgeSubtab";

describe("Knowledge sub-tab URL state", () => {
	it("recognises the bookmarkable Files target and rejects unrecognised values", () => {
		expect(knowledgeSubtabFromSearch(new URLSearchParams("subtab=files"))).toBe("files");
		expect(knowledgeSubtabFromSearch(new URLSearchParams("subtab=made-up"))).toBeNull();
	});

	it("changes only subtab, retaining unrelated query state for reload and navigation", () => {
		const next = searchWithKnowledgeSubtab(new URLSearchParams("builds=repo_1&subtab=docs"), "files");
		expect(next.toString()).toBe("builds=repo_1&subtab=files");
	});
});
