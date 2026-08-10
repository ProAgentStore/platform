import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The only part of a design system a machine can actually hold.
 *
 * PAGS runs its own design system (it is explicitly out of scope of the shared
 * six-store `DESIGN-SYSTEM.md` as of 2026-08-07 — dark-only, own tokens). Owning
 * it is a reason to have named tokens, not a licence to scatter Tailwind
 * literals, and #368 is what the absence of a check looks like: eleven
 * light-theme badge pairs sat in DataTab for months on an app with no light
 * theme, in a file nobody had reason to reopen.
 *
 * Two things here, chosen because both are mechanical and both correspond to a
 * defect that actually shipped. Everything else about the system — spacing
 * rhythm, when a control is a button rather than a link, density — is taste, and
 * a lint that pretends otherwise just teaches people to suppress it.
 *
 * These are gates where the count is already zero and a RATCHET where it is not,
 * following the same rule as ci.yml's lint step: a gate can only be turned on
 * where the tree is already clean, and a number that may only go down is the
 * honest instrument for the rest.
 */

const CONSOLE_SRC = join(import.meta.dirname, "..");
const ADMIN_SRC = join(import.meta.dirname, "../../../admin/src");
/**
 * The Coder UI ships INSIDE the console — `index.css` `@source`s it so its classes are
 * compiled against the console's tokens — but it lives outside `store/`, so the first cut
 * of this guard scanned two of the three trees that share one palette. Three pale-surface
 * banners were sitting in it while both gates read green: a signed-out notice rendered
 * twice and the runner-offline CTA, each a cream box with dark text and a white code block
 * on a black page. Exactly the defect the gate exists for, in the tree it did not look at.
 */
const CODER_WEB_SRC = join(import.meta.dirname, "../../../../agents/coder/web/src");

const TAILWIND_HUES =
	"slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";

/** Any numbered Tailwind palette class — the thing tokens exist to replace. */
const RAW_PALETTE = new RegExp(`\\b(?:bg|text|border|ring|fill|stroke|from|via|to)-(?:${TAILWIND_HUES})-(?:50|[1-9]00|950)(?:\\/\\d+)?\\b`, "g");

/**
 * The light-theme signature specifically: a very light background paired with
 * dark text. Legible on white, wrong on `--color-paper: #0a0a0a`.
 */
const LIGHT_SURFACE = new RegExp(`\\b(?:bg|border)-(?:${TAILWIND_HUES})-(?:50|100|200)\\b`, "g");

/**
 * Third-party sign-in buttons are brand-specified: Google's guidelines mandate a
 * white button with a light border, and it is a white button on every site that
 * has one. It is not the app's own surface and does not follow the app's palette.
 */
const LIGHT_SURFACE_ALLOWED = new Set(["pages/Login.tsx"]);

function walk(dir: string, base = dir, out: string[] = []): string[] {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, e.name);
		if (e.isDirectory()) walk(full, base, out);
		else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(full.slice(base.length + 1));
	}
	return out;
}

function scan(base: string, re: RegExp): { file: string; hits: string[] }[] {
	const found: { file: string; hits: string[] }[] = [];
	for (const rel of walk(base)) {
		const hits = readFileSync(join(base, rel), "utf-8").match(re);
		if (hits) found.push({ file: rel, hits });
	}
	return found;
}

describe("no light-theme surfaces on a dark-only app (#368)", () => {
	it("the console uses no pale Tailwind background", () => {
		const offenders = scan(CONSOLE_SRC, LIGHT_SURFACE).filter((f) => !LIGHT_SURFACE_ALLOWED.has(f.file));
		expect(offenders.map((f) => `${f.file}: ${f.hits.join(" ")}`)).toEqual([]);
	});

	it("the admin app uses no pale Tailwind background", () => {
		const offenders = scan(ADMIN_SRC, LIGHT_SURFACE).filter((f) => !LIGHT_SURFACE_ALLOWED.has(f.file));
		expect(offenders.map((f) => `${f.file}: ${f.hits.join(" ")}`)).toEqual([]);
	});

	it("the Coder UI uses no pale Tailwind background", () => {
		const offenders = scan(CODER_WEB_SRC, LIGHT_SURFACE).filter((f) => !LIGHT_SURFACE_ALLOWED.has(f.file));
		expect(offenders.map((f) => `${f.file}: ${f.hits.join(" ")}`)).toEqual([]);
	});
});

describe("raw Tailwind palette classes — a ratchet, not a gate", () => {
	/**
	 * Not zero, so not a gate. What remains is a handful of accent hues the theme
	 * has no name for (board-only statuses, a few chart/label colours). They are
	 * legible on dark, so they are debt rather than a bug — but the count may only
	 * go DOWN.
	 *
	 * Pinned EXACTLY, like the file-size ratchet: removing a use must lower the pin
	 * in the same commit. A `<=` ceiling leaves the ground you just took available
	 * as headroom, which is numerically how the last ratchet here got spent.
	 */
	// +2 for #488: DeploymentCard.tsx uses 2 raw palette colours.
	const PINNED = { console: 35, admin: 1, coderWeb: 9 };

	it("the console holds its count", () => {
		const count = scan(CONSOLE_SRC, RAW_PALETTE).reduce((n, f) => n + f.hits.length, 0);
		expect(count).toBe(PINNED.console);
	});

	it("the admin app holds its count", () => {
		const count = scan(ADMIN_SRC, RAW_PALETTE).reduce((n, f) => n + f.hits.length, 0);
		expect(count).toBe(PINNED.admin);
	});

	it("the Coder UI holds its count", () => {
		const count = scan(CODER_WEB_SRC, RAW_PALETTE).reduce((n, f) => n + f.hits.length, 0);
		expect(count).toBe(PINNED.coderWeb);
	});
});

describe("the two @theme blocks are one palette", () => {
	/**
	 * `store/admin/src/index.css` says "Design tokens — shared with the console".
	 * They are shared by COPY, so the comment is a claim nothing was keeping true:
	 * either file could be edited alone and the two apps would drift apart at
	 * whatever hue someone touched. This makes the claim checkable.
	 */
	const theme = (css: string): Record<string, string> => {
		const block = css.match(/@theme\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
		const out: Record<string, string> = {};
		for (const line of block.split("\n")) {
			const m = line.match(/^\s*(--[\w-]+):\s*(.+?);\s*$/);
			if (m) out[m[1]] = m[2].trim();
		}
		return out;
	};

	it("declares the same tokens with the same values in console and admin", () => {
		const consoleTheme = theme(readFileSync(join(CONSOLE_SRC, "index.css"), "utf-8"));
		const adminTheme = theme(readFileSync(join(ADMIN_SRC, "index.css"), "utf-8"));
		expect(Object.keys(consoleTheme).length).toBeGreaterThan(10); // the parse actually found something
		expect(adminTheme).toEqual(consoleTheme);
	});
});
