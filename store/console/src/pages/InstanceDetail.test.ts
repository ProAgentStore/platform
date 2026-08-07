import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SURFACES } from "../lib/surfaces";

/**
 * #240 — one mounted page per instance.
 *
 * `/instances/:id/*` is a single route, so switching agents changes a param while React keeps the
 * same component instance and all of its state: the previous agent's lists AND populated form
 * fields stay on screen, and a submit handler builds its URL from the CURRENT id — so Save could
 * write agent A's values to agent B.
 *
 * These are structural assertions on the source, because the guarantee is structural: nothing a
 * tab does can leak across a remount, and no runtime test can prove the absence of leaks in the
 * ~10 tabs individually. Keeping the key at the routed component is what makes that true for
 * tabs that do not exist yet.
 */

const SRC = readFileSync(join(__dirname, "InstanceDetail.tsx"), "utf8");
const CODE = SRC.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, "").replace(/^\s*\/\/.*$/gm, "");
/** Comments intact — the suppression checks below are ABOUT a comment and where it sits. */
const LINES = SRC.split("\n");

describe("the instance page is keyed by the instance", () => {
	it("renders the stateful page under a key derived from the route param", () => {
		expect(CODE).toMatch(/<InstancePage key=\{id \|\| "none"\} \/>/);
	});

	it("keeps the stateful page private, so it cannot be mounted unkeyed", () => {
		// An export would let a future caller render it directly and quietly reintroduce the bug.
		expect(CODE).not.toMatch(/export\s+(default\s+)?function\s+InstancePage/);
		expect(CODE).toMatch(/export default function InstanceDetail\(\)/);
	});

	it("does not write an instance response that outlived its effect", () => {
		// The capabilities this sets decide which tabs render — landing one from the previous
		// agent is precisely the wrong-agent-on-screen failure.
		expect(CODE).toContain("if (inst && live)");
	});
});

/**
 * #309 / #326 — the two memo keys that have taken the instance tabs down.
 *
 * `surfaceCaps` and `tabDefs` are keyed on the CONTENT of their inputs (`surfaces.join(",")`),
 * not on identity. They have to be: `surfaces` is `instance?.capabilities?.surfaces || []`, which
 * mints a fresh array on every render whenever the capability is absent, so an identity-keyed
 * memo there is not a memo. Both feed the header injected into the app shell — an unstable
 * `tabDefs` replaces the instance tab bar continuously, and a click lands on a node that no
 * longer exists. That is #309: the tabs render and do not switch.
 *
 * `useExhaustiveDependencies` recommends exactly the change that caused it, and offers it as a
 * FIXABLE autofix — one `--write`, or one reader taking the advice at face value, and the page is
 * dead again. So the deps carry a `biome-ignore` with the reason.
 *
 * The suppressions then failed a second, quieter way. A `biome-ignore` covers the line that
 * FOLLOWS it, and both had drifted behind more prose: one sat two lines above its statement, the
 * other inside the `useMemo` call before the dep array, while the diagnostic is raised on the
 * call itself. Both suppressed nothing — Biome said so, into a `pnpm lint` that had never run in
 * CI (#326). Placement is checked here as well as the keys, because placement is what makes the
 * reason binding rather than decorative.
 */
describe.each(["surfaceCaps", "tabDefs"])("%s is keyed by value (#309)", (name) => {
	/** The dependency array of the `useMemo` assigned to `name`, as written. */
	const deps = (): string => {
		const start = SRC.indexOf(`const ${name} = useMemo(`);
		expect(start, `${name} is no longer a useMemo — read #309 before changing this`).toBeGreaterThan(-1);
		const end = SRC.indexOf(");", start);
		const body = SRC.slice(start, end);
		const open = body.lastIndexOf("[");
		return body.slice(open, body.indexOf("]", open) + 1);
	};
	/** The line the diagnostic is raised on is the `useMemo` call; only the line above covers it. */
	const lineAbove = (): string => {
		const i = LINES.findIndex((l) => l.includes(`const ${name} = useMemo(`));
		expect(i, `${name} not found`).toBeGreaterThan(0);
		return LINES[i - 1];
	};

	it("compares its inputs by content, not by identity", () => {
		expect(deps(), `${name} deps ${deps()} — identity here is not a memo at all`).toContain('.join(",")');
	});

	it("does not list the raw arrays, which is what the lint's autofix adds", () => {
		for (const raw of ["[surfaces,", ", surfaces]", ", declaredTools]", "[customSurfaces,", ", customSurfaces]"]) {
			expect(deps(), `${name} deps ${deps()}`).not.toContain(raw);
		}
	});

	it("carries a suppression on the line IMMEDIATELY above — the only line it covers", () => {
		expect(lineAbove(), `line above ${name}: ${lineAbove()}`).toContain("biome-ignore lint/correctness/useExhaustiveDependencies");
	});

	it("gives the reason on that same line, since a reason that wraps is a suppression that moved", () => {
		const above = lineAbove();
		const reason = above.slice(above.indexOf("useExhaustiveDependencies:") + "useExhaustiveDependencies:".length).trim();
		expect(reason.length, `no reason given above ${name}`).toBeGreaterThan(20);
	});
});

describe("the shell owns the remount, not the individual surfaces", () => {
	it("renders every surface through the one keyed page", () => {
		// Before the fix exactly ONE surface (CodingTab, via `key={instanceId}` in the registry)
		// was remounted per instance; the other ~10 received a changed prop on a live component.
		// The registry says WHICH surfaces exist — it must not be where the lifetime rule lives,
		// or a surface added later inherits the bug by omission.
		expect(SURFACES.filter((s) => s.render).length).toBeGreaterThan(1);
		expect(CODE).toContain("const active = SURFACES.find((s) => s.id === tab);");
	});
});
