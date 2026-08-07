import { describe, expect, it } from "vitest";
import { INTENT_CLASS, statusBadgeClass, statusIntent } from "./statusBadge";

describe("statusIntent", () => {
	it("routes each status family to its intent", () => {
		expect(statusIntent("won")).toBe("success");
		expect(statusIntent("completed")).toBe("success");
		expect(statusIntent("none")).toBe("success");
		expect(statusIntent("failed")).toBe("danger");
		expect(statusIntent("contacted")).toBe("warning");
		expect(statusIntent("interrupted")).toBe("warning");
		expect(statusIntent("unreachable")).toBe("warning");
		expect(statusIntent("new")).toBe("info");
		expect(statusIntent("running")).toBe("info");
		expect(statusIntent("dead")).toBe("neutral");
	});

	it("falls back to neutral rather than inventing a colour", () => {
		expect(statusIntent("wat")).toBe("neutral");
		expect(statusIntent("")).toBe("neutral");
	});

	it("is case- and whitespace-insensitive", () => {
		expect(statusIntent(" Failed ")).toBe("danger");
		expect(statusIntent("RUNNING")).toBe("info");
	});
});

describe("statusBadgeClass", () => {
	it("emits only @theme tokens — never a raw Tailwind palette class", () => {
		// The bug this module exists for: a 100-level background under 700-level
		// text is the light-mode pairing, and this app has no light theme. Spelled
		// as a pattern rather than a literal so Tailwind's source scan (which reads
		// comments and strings alike) does not re-emit the very rules being banned.
		const rawPalette = /-(?:slate|gray|zinc|neutral|stone|amber|orange|violet|purple|emerald|sky|rose)-\d{2,3}\b|-(?:green|red|yellow|blue)-\d{2,3}\b/;
		for (const cls of Object.values(INTENT_CLASS)) {
			expect(cls).not.toMatch(rawPalette);
		}
	});

	it("pairs a tinted background with a solid foreground of the same token", () => {
		expect(statusBadgeClass("won")).toBe("bg-green/15 text-green");
		expect(statusBadgeClass("failed")).toBe("bg-red/15 text-red");
		expect(statusBadgeClass("dead")).toBe("bg-muted/15 text-muted");
	});

	it("agrees with itself across the two surfaces that render chips", () => {
		// DataTab's runs table and BoardTab's cards both show `running`/`completed`/
		// `failed`; they must not disagree about what those look like.
		for (const s of ["running", "completed", "failed"]) {
			expect(statusBadgeClass(s)).toBe(INTENT_CLASS[statusIntent(s)]);
		}
	});
});
