/**
 * Read an ADR, and the rules it states, ONCE — for every test that enforces one.
 *
 * `packages/sdk/src/voice/mute-invariant.test.ts` (#388) does not copy ADR 0001's rule ids into
 * the test; it parses them OUT of the document and fails when a stated rule has no coverage. That
 * is what makes a fifth rule a visible test change rather than a silent gap.
 *
 * The touch half of the same ADR is enforced from a different package
 * (`store/console/src/pages/mute-touch-invariant.test.ts`, also #388), and a SECOND copy of that
 * regex would be exactly the failure mode ADR 0001 exists to prevent: two readers of one document,
 * drifting apart, both green. One would keep agreeing with the ADR's format while the other quietly
 * stopped parsing anything — and "no rules parsed" is indistinguishable from "every rule covered"
 * unless someone asserts otherwise. So the parse lives here, once, and throws rather than returning
 * an empty list.
 *
 * Deliberately `.mjs` with a hand-written `.d.mts`: the three consumers live in three packages with
 * three tsconfigs and three rootDirs, and this is the only shape all of them can import by relative
 * path without either package claiming the other's source tree.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ADR_DIR = fileURLToPath(new URL("../../docs/adr/", import.meta.url));

/**
 * A rule, as `docs/adr/README.md` says a Decision must be written — "stated so it can be checked".
 * In prose that is a bolded id, an em dash, and a sentence: `**M1 — Reachable at every moment.**`
 */
const RULE = /^\*\*([A-Z]+\d+) — /gm;

/**
 * @param {number} number ADR number, e.g. `1` for `docs/adr/0001-*.md`.
 * @returns {{ id: string, file: string, path: string, text: string, rules: string[] }}
 */
export function readAdr(number) {
	const id = String(number).padStart(4, "0");
	const name = readdirSync(ADR_DIR).find((f) => f.startsWith(`${id}-`) && f.endsWith(".md"));
	// An ADR is never renumbered and never deleted — it is superseded (docs/adr/README.md). So this
	// is not a missing-file error, it is the convention itself having been broken.
	if (!name) throw new Error(`No ADR ${id} under docs/adr — an ADR is superseded, never renumbered or removed (docs/adr/README.md).`);
	const path = join(ADR_DIR, name);
	const text = readFileSync(path, "utf-8");
	const rules = [...text.matchAll(RULE)].map((m) => m[1]);
	if (rules.length === 0) throw new Error(`docs/adr/${name} states no rules in the form "**M1 — …" — the document's format changed under the tests that read it, and every coverage check against it is now asserting nothing.`);
	return { id, file: `docs/adr/${name}`, path, text, rules };
}
