/**
 * Glob patterns over repo-relative paths, for `repo_find` (#1070).
 *
 * `repo_find` matched its pattern as a plain substring, so `*.test.js` returned NOTHING — no path
 * contains an asterisk — and an agent concluded a repository with ~90 test files had none. Silent false
 * negatives are the failure; this is the matcher that ends them.
 *
 * Semantics (gitignore/ripgrep-like, case-insensitive like the substring search it extends):
 *   `*`    any run of characters within ONE path segment (never a `/`)
 *   `**`   any run across segments; `**` followed by `/` also matches zero folders
 *   `?`    one character, not `/`
 *   `[ab]` `[a-z]` `[!ab]`  a character class (`!` negates), never `/`
 * A pattern WITHOUT a `/` matches any single segment — a file name or a folder name at any depth, a
 * folder matching taking everything beneath it — so `*.test.js` and `*e2e*` mean what they mean in a
 * shell or `rg -g`. A pattern WITH a `/` is anchored at the repository root (`src/*.ts`,
 * `**\/handlers/*.js`); a leading `/` or `./` is accepted and means the same.
 *
 * DUPLICATED in `workers/api/src/lib/path-glob.ts`: the cloud filters with it when the runner is too old
 * to (an old runner ignores `glob`). `workers/api/src/lib/path-glob.parity.test.ts` holds the two equal.
 */

/** Does this pattern use glob syntax? A pattern without any is the plain substring search, unchanged. */
export function isGlob(pattern: string): boolean {
	return /[*?[]/.test(pattern);
}

function toRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				i++;
				if (glob[i + 1] === "/") {
					i++;
					re += "(?:.*/)?";
				} else re += ".*";
			} else re += "[^/]*";
		} else if (c === "?") re += "[^/]";
		else if (c === "[") {
			const end = glob.indexOf("]", i + 2);
			if (end === -1) {
				re += "\\[";
				continue;
			}
			let body = glob.slice(i + 1, end).replace(/[\\^\]]/g, "\\$&");
			const negate = body.startsWith("!");
			if (negate) body = body.slice(1);
			re += `(?!/)[${negate ? "^" : ""}${body}]`;
			i = end;
		} else re += c.replace(/[.+^${}()|\\\]/]/g, "\\$&");
	}
	return new RegExp(`^${re}$`, "i");
}

/** Does `path` (repo-relative, `/`-separated) match `glob`? */
export function globMatches(glob: string, path: string): boolean {
	const g = glob.trim().replace(/^\.?\/+/, "").replace(/\/+$/, "");
	if (!g) return false;
	const re = toRegExp(g);
	if (g.includes("/")) return re.test(path);
	return path.split("/").some((segment) => re.test(segment));
}

/**
 * The longest run of literal text a match MUST contain — what an old runner's substring search is given,
 * so the glob filter then runs over a superset that cannot have dropped a match. `""` when there is none
 * (`*`, `**`, `???`): nothing literal to search by.
 */
export function globLiteral(glob: string): string {
	// Normalised exactly as `globMatches` normalises, or `./src/*.ts` would ask for "./src", which no path contains.
	const pieces = glob.trim().replace(/^\.?\/+/, "").split(/\[[^\]]*\]|[*?]+/);
	const longest = pieces.reduce((a, b) => (b.length > a.length ? b : a), "");
	return longest.replace(/^\/+|\/+$/g, "");
}
