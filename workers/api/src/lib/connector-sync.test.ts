import { describe, it, expect } from "vitest";
import {
	describeSync,
	resolveTraversalLimits,
	syncDecision,
	versionedTitle,
	walkFolderTree,
	SYNC_DEFAULT_DEPTH,
	SYNC_MAX_DEPTH,
	SYNC_MAX_FOLDERS,
	type TraversalNode,
} from "./connector-sync.js";

/** A fake provider tree: folder id → its children. Stands in for Drive/WorkDrive listing. */
type Tree = Record<string, TraversalNode[]>;

function lister(tree: Tree, onList?: (id: string) => void) {
	return async (folderId: string): Promise<TraversalNode[]> => {
		onList?.(folderId);
		const children = tree[folderId];
		if (!children) throw new Error(`no such folder: ${folderId}`);
		return children;
	};
}

const file = (id: string): TraversalNode => ({ id, isFolder: false });
const folder = (id: string): TraversalNode => ({ id, isFolder: true });

describe("resolveTraversalLimits — recursion is opt-in", () => {
	it("keeps the exact pre-#20 shape when recursion is off, so existing triggers are unchanged", () => {
		expect(resolveTraversalLimits({})).toMatchObject({ maxDepth: 0, maxFolders: 1 });
		expect(resolveTraversalLimits({ recursive: false, maxDepth: 9 })).toMatchObject({ maxDepth: 0, maxFolders: 1 });
	});

	it("defaults to a sane depth when recursion is asked for without one", () => {
		expect(resolveTraversalLimits({ recursive: true }).maxDepth).toBe(SYNC_DEFAULT_DEPTH);
		expect(resolveTraversalLimits({ recursive: true }).maxFolders).toBe(SYNC_MAX_FOLDERS);
	});

	it("clamps a depth that would let a sync scan an unbounded provider tree", () => {
		expect(resolveTraversalLimits({ recursive: true, maxDepth: 9999 }).maxDepth).toBe(SYNC_MAX_DEPTH);
		expect(resolveTraversalLimits({ recursive: true, maxDepth: -4 }).maxDepth).toBe(0);
		expect(resolveTraversalLimits({ recursive: true, maxDepth: 2.7 }).maxDepth).toBe(2);
	});
});

describe("walkFolderTree — bounded nested traversal", () => {
	it("shallow (depth 0) lists only the root, which is the old behaviour exactly", async () => {
		const tree: Tree = { root: [file("a"), folder("sub")], sub: [file("b")] };
		const listed: string[] = [];
		const out = await walkFolderTree("root", lister(tree, (id) => listed.push(id)), resolveTraversalLimits({}));
		expect(out.files.map((f) => f.id)).toEqual(["a"]);
		expect(listed).toEqual(["root"]); // never even asked for the subfolder
		expect(out.foldersScanned).toBe(1);
		expect(out.truncated).toBe(false);
	});

	it("collects files from nested folders under the granted root", async () => {
		const tree: Tree = {
			root: [file("a"), folder("sub1"), folder("sub2")],
			sub1: [file("b"), folder("deep")],
			sub2: [file("c")],
			deep: [file("d")],
		};
		const out = await walkFolderTree("root", lister(tree), resolveTraversalLimits({ recursive: true }));
		expect(out.files.map((f) => f.id).sort()).toEqual(["a", "b", "c", "d"]);
		expect(out.foldersScanned).toBe(4);
		expect(out.truncated).toBe(false);
	});

	it("stops at maxDepth — a deeper file is simply not reached", async () => {
		const tree: Tree = { root: [folder("l1")], l1: [folder("l2")], l2: [file("deep")] };
		const shallow = await walkFolderTree("root", lister(tree), resolveTraversalLimits({ recursive: true, maxDepth: 1 }));
		expect(shallow.files).toEqual([]);
		const deeper = await walkFolderTree("root", lister(tree), resolveTraversalLimits({ recursive: true, maxDepth: 2 }));
		expect(deeper.files.map((f) => f.id)).toEqual(["deep"]);
	});

	it("caps the number of folders listed and reports the walk as truncated", async () => {
		// A wide tree: the root holds more folders than the cap allows us to list.
		const kids = Array.from({ length: 20 }, (_, i) => folder(`f${i}`));
		const tree: Tree = { root: kids };
		for (const k of kids) tree[k.id] = [file(`file-${k.id}`)];
		const out = await walkFolderTree("root", lister(tree), { maxDepth: 3, maxFolders: 5, maxFiles: 500 });
		expect(out.foldersScanned).toBe(5);
		expect(out.truncated).toBe(true);
		expect(out.files.length).toBeLessThan(20);
	});

	it("caps the number of files collected", async () => {
		const tree: Tree = { root: Array.from({ length: 50 }, (_, i) => file(`f${i}`)) };
		const out = await walkFolderTree("root", lister(tree), { maxDepth: 2, maxFolders: 10, maxFiles: 7 });
		expect(out.files).toHaveLength(7);
		expect(out.truncated).toBe(true);
	});

	it("cannot loop on a cycle — each folder is visited at most once", async () => {
		const tree: Tree = { root: [folder("a")], a: [folder("root"), file("x")] };
		const listed: string[] = [];
		const out = await walkFolderTree("root", lister(tree, (id) => listed.push(id)), resolveTraversalLimits({ recursive: true }));
		expect(out.files.map((f) => f.id)).toEqual(["x"]);
		expect(listed.sort()).toEqual(["a", "root"]);
	});

	it("a subtree it cannot list is reported, not fatal — the rest still syncs", async () => {
		const tree: Tree = { root: [folder("ok"), folder("denied")], ok: [file("good")] };
		const out = await walkFolderTree("root", lister(tree), resolveTraversalLimits({ recursive: true }));
		expect(out.files.map((f) => f.id)).toEqual(["good"]);
		expect(out.errors).toHaveLength(1);
		expect(out.errors[0].folderId).toBe("denied");
	});

	it("is breadth-first, so a truncated walk keeps the files nearest the folder the user chose", async () => {
		const tree: Tree = {
			root: [file("shallow"), folder("sub")],
			sub: [file("deep")],
		};
		const out = await walkFolderTree("root", lister(tree), resolveTraversalLimits({ recursive: true }));
		expect(out.files[0].id).toBe("shallow");
	});
});

describe("syncDecision — update in place instead of duplicating (#20)", () => {
	it("imports a file it has never seen", () => {
		expect(syncDecision(null, "fp1")).toBe("import");
	});

	it("skips an unchanged file", () => {
		expect(syncDecision({ fingerprint: "fp1", importedDocId: "doc1" }, "fp1")).toBe("skip");
	});

	it("UPDATES the existing doc when the source changed — the duplicate bug", () => {
		expect(syncDecision({ fingerprint: "old", importedDocId: "doc1" }, "new")).toBe("update");
	});

	it("re-imports when the change is real but no doc id was ever recorded", () => {
		// A prior import that failed after writing state, or a row predating imported_doc_id.
		expect(syncDecision({ fingerprint: "old", importedDocId: null }, "new")).toBe("import");
	});

	it("creates a new doc per change only when versioning is explicitly chosen", () => {
		expect(syncDecision({ fingerprint: "old", importedDocId: "doc1" }, "new", true)).toBe("import");
		// …and an unchanged file is still a no-op even in versioned mode.
		expect(syncDecision({ fingerprint: "same", importedDocId: "doc1" }, "same", true)).toBe("skip");
	});
});

describe("versionedTitle", () => {
	it("stamps the copy so versions are distinguishable and ordered", () => {
		expect(versionedTitle("Handbook", new Date("2026-08-04T09:30:00Z"))).toBe("Handbook (2026-08-04 09:30)");
	});

	it("respects the 500-char title cap", () => {
		expect(versionedTitle("x".repeat(600), new Date()).length).toBeLessThanOrEqual(500);
	});
});

describe("describeSync", () => {
	it("reports updates separately from imports", () => {
		const msg = describeSync({ scanned: 10, imported: 2, updated: 3, skipped: 5, foldersScanned: 4, truncated: false });
		expect(msg).toContain("imported 2");
		expect(msg).toContain("updated 3");
		expect(msg).toContain("skipped 5");
		expect(msg).toContain("4 folder(s)");
		expect(msg).not.toContain("traversal limit");
	});

	it("says so when a limit stopped the walk, rather than implying a complete sync", () => {
		const msg = describeSync({ scanned: 500, imported: 10, updated: 0, skipped: 490, foldersScanned: 50, truncated: true }, 2);
		expect(msg).toContain("traversal limit");
		expect(msg).toContain("2 error(s)");
	});
});
