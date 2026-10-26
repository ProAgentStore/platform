/**
 * The executable form of the AppShell navigation contract (#1290, docs/appshell-navigation-contract.md).
 *
 * The documentation says not to stack a second navbar under the shell, and nothing enforced it: in Hiring the shell's mobile menu
 * received only "Workspace" while a second inline recruiter navbar held the real routes — the hamburger worked and was bypassed.
 * This reads an app's SOURCE with the TypeScript compiler (never a regex over JSX, never `eval`) and reports, for each shell element:
 *
 *   APPSHELL_NAV_STRAY         error  an application-level <nav> in the shell content beside the shell's own navigation
 *   APPSHELL_NAV_BYPASSED      warn   the shell declares no nav and the app renders its own primary <nav> in the content
 *   APPSHELL_NAV_INCOMPLETE    warn   the shell's nav lists one item (or none) while the content shows many more destinations
 *   APPSHELL_TOPBAR_OMITS_NAV  error  a custom `renderTopbar` that never places the supplied `ctx.nav`
 *   APPSHELL_EXEMPT_NO_REASON  error  an `appshell-nav-exempt:` opt-out with no reason
 *
 * It does NOT flag what the contract lists as outside the rule: breadcrumbs, tabs, footer navigation, admin/local sub-navigation,
 * pagination, a table of contents, or anything marked `data-nav="local"`. A <nav> is "primary-like" only when it links to two or
 * more destinations (or maps a list into links).
 *
 * LIMITS, stated so a clean report is read correctly: it is static. A component it cannot find in the scanned files is reported as
 * unresolved, not guessed at; a `nav` built by a function call has an unknown length, so INCOMPLETE is not raised on it; a
 * `renderTopbar` passed by reference from another file is not inspected. A clean report means "nothing the contract names was found
 * in what was read", not "the menu works" — rule 6 (a 375px browser test against the real shell) is still the proof of that.
 *
 * Opt out per shell, with a reason, in a comment on or just above the element:   // appshell-nav-exempt: <why this app is different>
 */
import ts from "typescript";

export const GUIDE_URL = "https://github.com/ProAgentStore/platform/blob/main/docs/appshell-navigation-contract.md";
export const DEFAULT_SHELLS = ["ProShell", "AppShell"];

/** GitHub's heading anchor for a rule heading such as "3. Do not render…" — kept here so a diagnostic links to the exact rule. */
export function anchorFor(heading) {
	return heading
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s-]/gu, "")
		.trim()
		.replace(/\s+/g, "-");
}
const RULE_TITLES = {
	1: "1. AppShell owns one primary app navigation",
	2: "2. Every primary destination is in nav or renderNav",
	3: "3. Do not render a second primary navbar in shell content",
};
const guide = (rule) => `${GUIDE_URL}#${anchorFor(RULE_TITLES[rule])}`;

const LOCAL_LABEL = /breadcrumb|pagination|table of contents|on this page|\btabs?\b|admin|settings|sub-?nav|secondary|local|footer|filter|stepper|steps|toc/i;
const LOCAL_COMPONENT = /^(Breadcrumbs?|Tabs?|TabList|TabBar|Pagination|Footer|Toc|TableOfContents|SubNav|AdminNav|LocalNav|Stepper)$/;
const LINK_TAGS = new Set(["a", "Link", "NavLink"]);

const kindFor = (file) => (/\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : /\.(ts|js|mjs)$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.TSX);
const tagOf = (el) => el.tagName.getText();
const attrOf = (el, name) => el.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText() === name);
/** An attribute's literal text: undefined when it is absent, "" when it has no value, null when it is not a literal. */
const strOf = (attr) => {
	if (!attr) return undefined;
	const init = attr.initializer;
	if (!init) return "";
	if (ts.isStringLiteral(init)) return init.text;
	if (ts.isJsxExpression(init) && init.expression && (ts.isStringLiteral(init.expression) || ts.isNoSubstitutionTemplateLiteral(init.expression))) return init.expression.text;
	return null; // present but dynamic
};
const walk = (node, visit) => {
	const go = (n) => {
		if (visit(n) === false) return;
		ts.forEachChild(n, go);
	};
	go(node);
};
const openingOf = (n) => (ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null);

/** Parse the given sources and index their function components by name. */
function index(sources) {
	const files = sources.map(({ file, text }) => ({ file, text, sf: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kindFor(file)) }));
	const components = new Map();
	for (const f of files) {
		walk(f.sf, (n) => {
			if (ts.isFunctionDeclaration(n) && n.name && /^[A-Z]/.test(n.name.text) && n.body) components.set(n.name.text, { file: f, node: n.body });
			if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /^[A-Z]/.test(n.name.text) && n.initializer) {
				let init = n.initializer;
				while (ts.isParenthesizedExpression(init) || ts.isAsExpression(init)) init = init.expression;
				if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) components.set(n.name.text, { file: f, node: init.body });
			}
		});
	}
	return { files, components };
}

/** Link targets inside a subtree: how many link elements, which literal destinations, and whether a mapped list renders links. */
function linksIn(root) {
	let count = 0;
	let mapped = false;
	const targets = new Set();
	walk(root, (n) => {
		const el = openingOf(n);
		if (el && LINK_TAGS.has(tagOf(el))) {
			count++;
			const t = strOf(attrOf(el, "href")) ?? strOf(attrOf(el, "to"));
			if (t) targets.add(t);
		}
		if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "map") {
			let hasLink = false;
			walk(n, (m) => {
				const e = openingOf(m);
				if (e && (LINK_TAGS.has(tagOf(e)) || /Link$/.test(tagOf(e)))) hasLink = true;
			});
			if (hasLink) mapped = true;
		}
	});
	return { count: mapped ? Math.max(count, 2) : count, targets, mapped };
}

/** Is this <nav> something the contract lists as outside the rule? */
function isLocalNav(el, ancestors) {
	const label = strOf(attrOf(el, "aria-label")) ?? "";
	if (label && LOCAL_LABEL.test(label)) return true;
	if (/^(tablist|tab|menubar)$/.test(strOf(attrOf(el, "role")) ?? "")) return true;
	if (strOf(attrOf(el, "data-nav")) === "local" || attrOf(el, "data-appshell-nav")) return true;
	return ancestors.some((a) => {
		const ae = openingOf(a);
		if (!ae) return false;
		const tag = tagOf(ae);
		return tag === "footer" || LOCAL_COMPONENT.test(tag) || /^(tablist)$/.test(strOf(attrOf(ae, "role")) ?? "") || strOf(attrOf(ae, "data-nav")) === "local";
	});
}

const lineOf = (f, node) => f.sf.getLineAndCharacterOfPosition(node.getStart(f.sf)).line + 1;

/** Find primary-like <nav> elements and route paths in a subtree, following components defined in the scanned files. */
function inspectContent(root, home, idx, via = [], seen = new Set(), depth = 0) {
	const out = { navs: [], routes: new Set(), unresolved: new Set() };
	const trail = [];
	const visit = (node) => {
		const stack = trail.slice();
		const el = openingOf(node);
		if (el) {
			const tag = tagOf(el);
			if (tag === "nav") {
				const links = linksIn(node);
				if (!isLocalNav(el, stack) && links.count >= 2 && (links.targets.size >= 2 || links.mapped)) out.navs.push({ file: home.file, line: lineOf(home, node), via, links });
			} else if (tag === "Route") {
				const p = strOf(attrOf(el, "path"));
				const seg = p?.replace(/^\/+/, "").split("/")[0];
				if (seg && !seg.startsWith(":") && seg !== "*") out.routes.add(seg);
			} else if (/^[A-Z]/.test(tag) && !LOCAL_COMPONENT.test(tag) && depth < 4 && !seen.has(tag)) {
				const comp = idx.components.get(tag);
				if (comp) {
					seen.add(tag);
					const inner = inspectContent(comp.node, comp.file, idx, [...via, tag], seen, depth + 1);
					out.navs.push(...inner.navs);
					for (const r of inner.routes) out.routes.add(r);
					for (const u of inner.unresolved) out.unresolved.add(u);
				} else if (/Nav|Menu|Sidebar/.test(tag)) out.unresolved.add(tag);
			}
		}
		trail.push(node);
		ts.forEachChild(node, visit);
		trail.pop();
	};
	visit(root);
	return out;
}

/** The shell's own `nav`: items known, or "dynamic" when it comes from a call, or null when absent. */
function shellNav(el, sf) {
	const attr = attrOf(el, "nav");
	if (!attr) return null;
	let expr = attr.initializer && ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : null;
	const resolve = (e) => {
		while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e))) e = e.expression;
		return e;
	};
	expr = resolve(expr);
	if (expr && ts.isIdentifier(expr)) {
		let found = null;
		walk(sf, (n) => {
			if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === expr.text && n.initializer) found = resolve(n.initializer);
		});
		expr = found;
	}
	if (expr && ts.isArrayLiteralExpression(expr)) return { items: expr.elements.length };
	return { dynamic: true };
}

/** Does a function (the `renderTopbar` value) use the `nav` it was given? Null when it cannot be read. */
function placesNav(fn, sf) {
	let f = fn;
	while (f && (ts.isParenthesizedExpression(f) || ts.isAsExpression(f))) f = f.expression;
	if (f && ts.isIdentifier(f)) {
		let found = null;
		walk(sf, (n) => {
			if (ts.isFunctionDeclaration(n) && n.name?.text === f.text) found = n;
			if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === f.text && n.initializer) found = n.initializer;
		});
		f = found;
	}
	if (!f || !(ts.isArrowFunction(f) || ts.isFunctionExpression(f) || ts.isFunctionDeclaration(f))) return null;
	const param = f.parameters[0];
	const body = f.body;
	if (!param || !body) return false;
	if (ts.isObjectBindingPattern(param.name)) {
		const bound = param.name.elements.find((e) => (e.propertyName ?? e.name).getText() === "nav");
		if (!bound) return false;
		const local = bound.name.getText();
		let used = false;
		walk(body, (n) => {
			if (ts.isIdentifier(n) && n.text === local) used = true;
		});
		return used;
	}
	const name = param.name.getText();
	let used = false;
	walk(body, (n) => {
		if (ts.isPropertyAccessExpression(n) && n.name.text === "nav" && n.expression.getText() === name) used = true;
		if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer?.getText() === name && n.name.elements.some((e) => (e.propertyName ?? e.name).getText() === "nav")) used = true;
	});
	return used;
}

function exemption(f, el) {
	const line = f.sf.getLineAndCharacterOfPosition(el.getStart(f.sf)).line;
	const lines = f.text.split("\n").slice(Math.max(0, line - 3), line + 1);
	for (const l of lines) {
		const m = /appshell-nav-exempt:?(.*)$/.exec(l);
		if (m) return { reason: m[1].replace(/\*\/\s*\}?\s*$/, "").trim() };
	}
	return null;
}

const diag = (f, node, code, severity, rule, message, fix) => ({ code, severity, file: f.file, line: lineOf(f, node), rule, message, fix, docs: guide(rule) });

/**
 * Analyse sources: `[{ file, text }]`. Returns `{ shells, diagnostics }`; `shells` is how many shell elements were found, so
 * "nothing found" is distinguishable from "all clear".
 */
export function analyzeSources(sources, opts = {}) {
	const shellNames = new Set(opts.shells ?? DEFAULT_SHELLS);
	const idx = index(sources);
	const diagnostics = [];
	let shells = 0;
	for (const f of idx.files) {
		walk(f.sf, (node) => {
			const el = openingOf(node);
			if (!el || !shellNames.has(tagOf(el))) return;
			// An app's own layout component may be called AppShell. If the scanned sources define it, it is not the SDK shell.
			if (idx.components.has(tagOf(el))) return;
			shells++;
			const exempt = exemption(f, el);
			if (exempt) {
				if (!exempt.reason) diagnostics.push(diag(f, el, "APPSHELL_EXEMPT_NO_REASON", "error", 1, "`appshell-nav-exempt` needs a reason: say why this app legitimately has no single shell-owned primary navigation.", "Write it as `// appshell-nav-exempt: <reason>` on or just above the shell element."));
				return;
			}
			const name = tagOf(el);
			const nav = shellNav(el, f.sf);
			const hasRenderNav = !!attrOf(el, "renderNav");
			const topbar = attrOf(el, "renderTopbar");
			const hidden = !!attrOf(el, "hideTopbar");
			// Only the children are "shell content". Attributes are not: a `renderTopbar={...}` is the topbar itself, and inspecting it
			// would call the app's own custom topbar a second navbar.
			const content = { navs: [], routes: new Set(), unresolved: new Set() };
			if (ts.isJsxElement(node)) {
				const seen = new Set();
				for (const child of node.children) {
					const part = inspectContent(child, f, idx, [], seen, 0);
					content.navs.push(...part.navs);
					for (const r of part.routes) content.routes.add(r);
					for (const u of part.unresolved) content.unresolved.add(u);
				}
			}

			const shellOwnsNav = hasRenderNav || (nav !== null && (nav.dynamic || nav.items > 0));
			const wholeNavIsTheApps = !nav && !hasRenderNav && !topbar;
			if (!hidden && wholeNavIsTheApps && content.navs.length) {
				const first = content.navs[0];
				diagnostics.push(
					diag(
						f,
						el,
						"APPSHELL_NAV_BYPASSED",
						"warn",
						1,
						`${name} declares no \`nav\`, and the content renders its own primary <nav> at ${first.file}:${first.line}${first.via.length ? ` (rendered by ${first.via.join(" > ")})` : ""}. The shell's responsive menu offers nothing, so the app's navigation has to handle phones itself.`,
						`Pass the app's primary destinations as \`nav\` and let the shell render them, or opt out with a reason: \`// appshell-nav-exempt: <why>\`.`,
					),
				);
			}
			if (!hidden && shellOwnsNav) {
				for (const stray of content.navs) {
					const where = stray.via.length ? ` (rendered by ${stray.via.join(" > ")})` : "";
					diagnostics.push(
						diag(
							f,
							el,
							"APPSHELL_NAV_STRAY",
							"error",
							3,
							`${name} renders its own navigation, but the content also renders a second primary <nav> at ${stray.file}:${stray.line}${where} linking to ${stray.links.mapped ? "a list of destinations" : `${stray.links.targets.size} destinations`}. On a phone the shell's menu is bypassed.`,
							`Move those destinations into ${name}'s \`nav\` (or \`renderNav\`) and delete the second navbar. If it is genuinely local navigation (tabs, breadcrumbs, an admin sub-navigation), mark it \`data-nav="local"\` or give it an aria-label that says so.`,
						),
					);
				}
			}
			if (nav && !nav.dynamic && nav.items <= 1 && !hidden && !hasRenderNav) {
				const stray = content.navs.reduce((n, s) => Math.max(n, s.links.targets.size), 0);
				if (stray >= 2 || content.routes.size >= 3) {
					diagnostics.push(
						diag(f, el, "APPSHELL_NAV_INCOMPLETE", "warn", 2, `${name}'s \`nav\` lists ${nav.items} destination${nav.items === 1 ? "" : "s"}, but the content shows ${stray >= 2 ? `a second navigation with ${stray} destinations` : `${content.routes.size} top-level routes`}. The shell's menu probably does not offer where the app actually goes.`, `List every primary destination in \`nav\`; see ${guide(2)}.`),
					);
				}
			} else if (wholeNavIsTheApps && !hidden && !content.navs.length && content.routes.size >= 2) {
				diagnostics.push(diag(f, el, "APPSHELL_NAV_INCOMPLETE", "warn", 2, `${name} has no \`nav\`, but the content declares ${content.routes.size} top-level routes. Users get no navigation.`, "Pass the app's primary destinations as `nav`."));
			}
			if (topbar && (hasRenderNav || (nav && (nav.dynamic || nav.items > 0)))) {
				const expr = topbar.initializer && ts.isJsxExpression(topbar.initializer) ? topbar.initializer.expression : null;
				if (placesNav(expr, f.sf) === false) {
					diagnostics.push(diag(f, el, "APPSHELL_TOPBAR_OMITS_NAV", "error", 3, `${name} supplies navigation, but its custom \`renderTopbar\` never places \`ctx.nav\`, so the declared navigation is not shown anywhere.`, "Render `ctx.nav` inside the custom topbar (it already carries the responsive menu)."));
				}
			}
		});
	}
	return { shells, diagnostics };
}
export const hasErrors = (diagnostics, strict = false) => diagnostics.some((d) => d.severity === "error" || (strict && d.severity === "warn"));
export function formatDiagnostic(d) {
	return `${d.severity === "error" ? "✗" : "!"} ${d.file}:${d.line}  ${d.code}\n    ${d.message}\n    Fix: ${d.fix}\n    Guide: ${d.docs}`;
}
