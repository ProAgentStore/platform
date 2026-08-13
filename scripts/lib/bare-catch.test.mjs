import { describe, expect, it } from "vitest";
import { bareCatches, stripCommentsAndLiterals } from "./bare-catch.mjs";

/**
 * The two mistakes a source-scanning guard can make here are the whole test (#291).
 *
 * Both were real on this tree the day the gate was written, in opposite directions: five `catch {}`
 * mentions live inside PROSE explaining a swallow that used to be there (a guard firing on its own
 * postmortem is a guard people suppress), and blanking comments to find them turns an ANNOTATED
 * catch into `catch {      }` — which is exactly what the gate is meant to accept. Locating in the
 * stripped source and judging on the original is what satisfies both, and that is worth a test
 * rather than a comment, because it is one refactor away from being silently wrong in either
 * direction.
 */
describe("bareCatches", () => {
	const lines = (src) => bareCatches(src);

	it("reports the obvious one, with its line", () => {
		expect(lines('try {\n\tx();\n} catch {}')).toEqual([3]);
	});

	it("reports it with a binding, and across two lines — the shape a line-grep misses", () => {
		// `parse-tool-calls.ts` held exactly this and was NOT in the count #291 reported.
		expect(lines("try { x(); } catch (e) {}")).toEqual([1]);
		expect(lines("try {\n\tx();\n} catch {\n}")).toEqual([3]);
	});

	it("accepts a catch that says why, which is the entire ask", () => {
		expect(lines("try { x(); } catch {\n\t// Ignorable: the caller already reported it.\n}")).toEqual([]);
		expect(lines("try { x(); } catch {\n\t/* Ignorable. */\n}")).toEqual([]);
	});

	it("accepts a catch that does something", () => {
		expect(lines("try { x(); } catch (e) { report(e); }")).toEqual([]);
	});

	it("does not read a catch out of a line comment", () => {
		// `agent-do.ts`, `lib/sql.ts`, `lib/d1-sqlite.ts` and `coding/runtime.ts` all narrate one.
		expect(lines("// The blanket `catch {}` here was covering ONE benign case.\nconst x = 1;")).toEqual([]);
	});

	it("does not read a catch out of a block comment or a doc comment", () => {
		expect(lines("/**\n * Almost every list loads through `try { setThing(await api()) } catch {}`.\n */\nconst x = 1;")).toEqual([]);
	});

	it("does not read a catch out of a string or a template literal", () => {
		expect(lines('const s = "} catch {}";')).toEqual([]);
		expect(lines("const s = `} catch {}`;")).toEqual([]);
	});

	it("finds a real one that FOLLOWS prose about a fake one", () => {
		// The regression that would make this guard useless without being obviously broken: strip
		// the comment, keep scanning, still see the code after it.
		expect(lines("// see `catch {}` above\ntry {\n\tx();\n} catch {}")).toEqual([4]);
	});

	it("is not fooled by a regex literal containing braces", () => {
		expect(lines("const re = /catch\\s*\\{\\s*\\}/;\ntry { x(); } catch { /* ok */ }")).toEqual([]);
	});

	it("counts every catch in a file, not just the first", () => {
		expect(lines("try{a()}catch{}\ntry{b()}catch{}\ntry{c()}catch{ /* fine */ }")).toEqual([1, 2]);
	});

	it("throws on a catch block whose brace never closes, instead of skipping it (ADR 0002 G3)", () => {
		// This used to be `if (close === -1) continue;` — the same line, in the same position, as
		// the one in `store/console/src/lib/jsx-tags.ts` that hid 33 tags and made a pinned count
		// wrong for months (#536). An unclosed block means the stripper lost its place, so every
		// catch after it in the file is unmeasured; the gate must say so rather than shrink.
		expect(() => lines("try { a(); } catch { if (x) {\n")).toThrow(/never closed/);
		expect(() => lines("try { a(); } catch { if (x) {\n")).toThrow(/G3/);
	});

	it("still skips the `catch` METHOD, which is not the same shape", () => {
		// `\bcatch\b` matches `p.catch(fn)` too. Skipping those is the guard working — the
		// distinction the throw above must not blur.
		expect(lines("p.catch((e) => log(e));\nq.catch(noop);")).toEqual([]);
	});
});

describe("stripCommentsAndLiterals", () => {
	it("preserves length and newlines, which is what lets the original be read at the same offsets", () => {
		const src = 'const a = "hello"; // note\nconst b = 1;';
		const out = stripCommentsAndLiterals(src);
		expect(out).toHaveLength(src.length);
		expect(out.split("\n")).toHaveLength(2);
		expect(out).not.toContain("hello");
		expect(out).not.toContain("note");
		expect(out).toContain("const b = 1;");
	});

	it("leaves division alone rather than eating the rest of the line as a regex", () => {
		expect(stripCommentsAndLiterals("const r = total / count;\nconst z = 2;")).toContain("const z = 2;");
	});
});
