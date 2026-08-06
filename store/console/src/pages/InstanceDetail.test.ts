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
