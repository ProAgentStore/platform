/**
 * #1290 — the AppShell navigation contract as an executable check, on fixtures: the Hiring shape is flagged with an actionable
 * diagnostic that links to the guide; every navigation the contract lists as outside the rule is NOT flagged; and the analyser reports
 * what it could not read instead of guessing. Fixtures are source strings parsed by the real TypeScript compiler.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeSources, anchorFor, formatDiagnostic, GUIDE_URL, hasErrors } from "./appshell-navigation.mjs";

const root = resolve(import.meta.dirname, "../..");
const run = (text, file = "App.tsx") => analyzeSources([{ file, text }]);
const codes = (r) => r.diagnostics.map((d) => d.code);

/** The Hiring shape: the shell gets one destination, a second inline navbar holds the real routes. */
const HIRING = `
import { ProShell } from '@proappstore/sdk/shell';
const NAV = [{ label: 'Workspace', href: '/workspace' }];
export default function App() {
  return (
    <ProShell app={app} appName="Hiring" nav={NAV} onNavigate={navigate}>
      <nav className="recruiter">
        <Link to="/jobs">Jobs</Link>
        <Link to="/candidates">Candidates</Link>
        <Link to="/interviews">Interviews</Link>
      </nav>
      <Routes>
        <Route path="/jobs" element={<Jobs />} />
        <Route path="/candidates" element={<Candidates />} />
        <Route path="/interviews" element={<Interviews />} />
      </Routes>
    </ProShell>
  );
}`;

describe("the Hiring shape", () => {
	const r = run(HIRING);

	it("is flagged: a second primary navbar (error) and an incomplete shell nav (warning)", () => {
		expect(r.shells).toBe(1);
		expect(codes(r).sort()).toEqual(["APPSHELL_NAV_INCOMPLETE", "APPSHELL_NAV_STRAY"]);
		expect(r.diagnostics.find((d) => d.code === "APPSHELL_NAV_STRAY").severity).toBe("error");
		expect(r.diagnostics.find((d) => d.code === "APPSHELL_NAV_INCOMPLETE").severity).toBe("warn");
		expect(hasErrors(r.diagnostics)).toBe(true);
	});

	it("says where, what to do, and links to the exact rule in the guide", () => {
		const stray = r.diagnostics.find((d) => d.code === "APPSHELL_NAV_STRAY");
		expect(stray.file).toBe("App.tsx");
		expect(stray.line).toBeGreaterThan(0);
		expect(stray.message).toContain("second primary <nav>");
		expect(stray.message).toContain("3 destinations");
		expect(stray.fix).toContain("`nav`");
		expect(stray.docs.startsWith(GUIDE_URL)).toBe(true);
		expect(stray.docs).toBe(`${GUIDE_URL}#3-do-not-render-a-second-primary-navbar-in-shell-content`);
		expect(formatDiagnostic(stray)).toContain(stray.docs);
	});

	it("the incomplete-nav warning counts what it saw and points at rule 2", () => {
		const inc = r.diagnostics.find((d) => d.code === "APPSHELL_NAV_INCOMPLETE");
		expect(inc.message).toMatch(/lists 1 destination/);
		expect(inc.docs).toContain("#2-every-primary-destination-is-in-nav-or-renderNav".toLowerCase());
	});

	it("is found when the second navbar lives in another component and another file", () => {
		const layout = "export function RecruiterLayout() { return <div><nav><a href='/jobs'>Jobs</a><a href='/candidates'>Candidates</a></nav><Outlet /></div>; }";
		const app = "export default function App() { return <ProShell app={app} nav={[{ label: 'Workspace', href: '/w' }]}><RecruiterLayout /></ProShell>; }";
		const out = analyzeSources([
			{ file: "App.tsx", text: app },
			{ file: "RecruiterLayout.tsx", text: layout },
		]);
		const stray = out.diagnostics.find((d) => d.code === "APPSHELL_NAV_STRAY");
		expect(stray.message).toContain("RecruiterLayout.tsx");
		expect(stray.message).toContain("rendered by RecruiterLayout");
	});

	it("is found when the navbar maps a list into links", () => {
		const text = "const NAV=[{label:'W',href:'/w'}]; const X = () => <ProShell app={a} nav={NAV}><nav>{items.map((i) => <NavLink key={i.to} to={i.to}>{i.label}</NavLink>)}</nav></ProShell>;";
		expect(codes(run(text))).toContain("APPSHELL_NAV_STRAY");
	});
});

const shellWith = (inside, props = "nav={[{label:'Home',href:'/'},{label:'Cases',href:'/cases'}]}") => `const A = () => <ProShell app={a} ${props}>${inside}</ProShell>;`;

describe("navigation the contract lists as outside the rule is NOT flagged", () => {
	const links = "<a href='/a'>A</a><a href='/b'>B</a><a href='/c'>C</a>";
	it.each([
		["breadcrumbs (aria-label)", `<nav aria-label="Breadcrumb">${links}</nav>`],
		["breadcrumbs (component)", `<Breadcrumbs>${links}</Breadcrumbs>`],
		["tabs (role=tablist)", `<nav role="tablist">${links}</nav>`],
		["tabs (component)", `<Tabs><nav>${links}</nav></Tabs>`],
		["footer navigation (element)", `<footer><nav>${links}</nav></footer>`],
		["footer navigation (label)", `<nav aria-label="Footer">${links}</nav>`],
		["an admin sub-navigation", `<nav aria-label="Admin sections">${links}</nav>`],
		["a settings sub-navigation", `<nav aria-label="Settings">${links}</nav>`],
		["pagination", `<nav aria-label="Pagination">${links}</nav>`],
		["a table of contents", `<nav aria-label="On this page">${links}</nav>`],
		["a nav explicitly marked local", `<nav data-nav="local">${links}</nav>`],
		["a nav with a single link", "<nav><a href='/back'>Back</a></nav>"],
		["ordinary in-content links", `<p>${links}</p>`],
	])("%s", (_name, inside) => {
		const out = run(shellWith(inside));
		expect(out.shells).toBe(1);
		expect(codes(out)).toEqual([]);
	});

	it("a shell with a complete nav and no other navigation is clean", () => {
		expect(codes(run(shellWith("<Routes><Route path='/' element={<Home />} /></Routes>")))).toEqual([]);
	});

	it("an app that opts out of the topbar entirely (hideTopbar) owns its own navigation", () => {
		expect(codes(run(shellWith(`<nav>${links}</nav>`, "hideTopbar")))).toEqual([]);
	});
});

describe("a custom topbar that omits ctx.nav", () => {
	const props = (fn) => `nav={[{label:'Home',href:'/'},{label:'Cases',href:'/cases'}]} renderTopbar={${fn}}`;
	it("is flagged, as an error, with the fix", () => {
		const out = run(shellWith("<Home />", props("(ctx) => <header>{ctx.profileMenu}</header>")));
		expect(codes(out)).toEqual(["APPSHELL_TOPBAR_OMITS_NAV"]);
		expect(out.diagnostics[0].severity).toBe("error");
		expect(out.diagnostics[0].fix).toContain("ctx.nav");
		expect(out.diagnostics[0].docs).toContain("#3-");
	});
	it.each([
		["places ctx.nav", "(ctx) => <header>{ctx.nav}{ctx.profileMenu}</header>"],
		["destructures and places nav", "({ nav, profileMenu }) => <header>{nav}{profileMenu}</header>"],
		["aliases the context then reads nav", "(ctx) => { const { nav } = ctx; return <header>{nav}</header>; }"],
	])("%s: not flagged", (_n, fn) => {
		expect(codes(run(shellWith("<Home />", props(fn))))).toEqual([]);
	});
	it("destructuring that never uses nav is flagged", () => {
		expect(codes(run(shellWith("<Home />", props("({ profileMenu }) => <header>{profileMenu}</header>"))))).toEqual(["APPSHELL_TOPBAR_OMITS_NAV"]);
	});
	it("a topbar passed by reference is read from the same file", () => {
		const text = "function Top(ctx) { return <header>{ctx.profileMenu}</header>; } const A = () => <ProShell app={a} nav={[{label:'H',href:'/'},{label:'C',href:'/c'}]} renderTopbar={Top}><X /></ProShell>;";
		expect(codes(run(text))).toEqual(["APPSHELL_TOPBAR_OMITS_NAV"]);
	});
	it("a topbar with nothing to place (no nav declared) is not an error", () => {
		expect(codes(run("const A = () => <ProShell app={a} renderTopbar={(ctx) => <header />}><X /></ProShell>;"))).toEqual([]);
	});
});

describe("honesty about what it cannot see", () => {
	it("a nav built by a call has an unknown length, so it is never called incomplete", () => {
		const text = "const A = () => <ProShell app={a} nav={useNav(role)}><Routes><Route path='/a' /><Route path='/b' /><Route path='/c' /></Routes></ProShell>;";
		expect(codes(run(text))).toEqual([]);
	});
	it("a single-item nav is not incomplete on its own — only when the content shows more", () => {
		expect(codes(run("const A = () => <ProShell app={a} nav={[{label:'Home',href:'/'}]}><Home /></ProShell>;"))).toEqual([]);
	});
	it("a nav-like component it cannot find is not guessed at as a stray navbar", () => {
		const out = run("const A = () => <ProShell app={a} nav={[{label:'H',href:'/'},{label:'C',href:'/c'}]}><RecruiterNav /></ProShell>;");
		expect(codes(out)).toEqual([]);
	});
	it("reports how many shells it found, so 'none' is not mistaken for 'all clear'", () => {
		expect(run("export const x = 1;").shells).toBe(0);
		expect(run(HIRING).shells).toBe(1);
	});
	it("the shell can be named AppShell as well as ProShell", () => {
		expect(codes(run(HIRING.replaceAll("ProShell", "AppShell")))).toContain("APPSHELL_NAV_STRAY");
	});
});

describe("shapes found in real apps (read-only scan of the ProAppStore apps, #1290)", () => {
	it("a custom renderTopbar that renders the app's own nav is the documented custom path, not a second navbar", () => {
		const text = `const Topbar = ({ profileMenu }) => <header><nav><NavLink to="/a">A</NavLink><NavLink to="/b">B</NavLink><NavLink to="/c">C</NavLink></nav>{profileMenu}</header>;
export const L = () => <ProShell app={app} appName="TradePort" renderTopbar={(ctx) => <Topbar profileMenu={ctx.profileMenu} />}><Gate>{children}</Gate></ProShell>;`;
		const out = run(text);
		expect(out.shells).toBe(1);
		expect(codes(out)).toEqual([]);
	});

	it("a layout component the app defines itself and happens to call AppShell is not the SDK shell", () => {
		const text = `function AppShell() { return <div><nav aria-label="Sidebar navigation"><a href="/a">A</a><a href="/b">B</a></nav></div>; }
export default function App() { return <ProShell app={app} appName="TT"><BrowserRouter><AppShell /></BrowserRouter></ProShell>; }`;
		const out = run(text);
		expect(out.shells).toBe(1);
	});

	it("no shell nav and the app's own navigation in the content is BYPASSED (a warning), not a 'second' navbar and not 'no navigation'", () => {
		const text = `function Side() { return <nav aria-label="Sidebar navigation"><NavLink to="/a">A</NavLink><NavLink to="/b">B</NavLink><NavLink to="/c">C</NavLink></nav>; }
export default function App() { return <ProShell app={app} appName="TT"><Side /><Routes><Route path="/a" /><Route path="/b" /><Route path="/c" /></Routes></ProShell>; }`;
		const out = run(text);
		expect(codes(out)).toEqual(["APPSHELL_NAV_BYPASSED"]);
		expect(out.diagnostics[0].severity).toBe("warn");
		expect(out.diagnostics[0].message).toContain("declares no `nav`");
		expect(hasErrors(out.diagnostics)).toBe(false);
	});

	it("no shell nav, no navigation anywhere, several routes: the 'no navigation' warning still applies", () => {
		const text = "export const A = () => <ProShell app={a}><Routes><Route path='/a' /><Route path='/b' /><Route path='/c' /></Routes></ProShell>;";
		expect(codes(run(text))).toEqual(["APPSHELL_NAV_INCOMPLETE"]);
	});

	it("attributes of the shell are never content", () => {
		const text = `export const A = () => <ProShell app={a} nav={[{label:'H',href:'/'},{label:'C',href:'/c'}]} renderFooter={() => <nav><a href="/x">x</a><a href="/y">y</a></nav>}><Home /></ProShell>;`;
		expect(codes(run(text))).toEqual([]);
	});
});

describe("the documented opt-out", () => {
	const withComment = (comment) => HIRING.replace("return (\n    <ProShell", `return (\n    // ${comment}\n    <ProShell`);
	it("an exempt shell, with a reason, is skipped entirely", () => {
		const text = withComment("appshell-nav-exempt: single-purpose kiosk, the content bar is the only navigation");
		expect(text).not.toBe(HIRING);
		expect(run(text).shells).toBe(1);
		expect(codes(run(text))).toEqual([]);
	});
	it("an exemption with no reason is itself an error, and the shell is still checked no further", () => {
		const text = withComment("appshell-nav-exempt:");
		expect(text).not.toBe(HIRING);
		expect(codes(run(text))).toEqual(["APPSHELL_EXEMPT_NO_REASON"]);
		expect(hasErrors(run(text).diagnostics)).toBe(true);
	});
	it("without the comment the same shell is flagged", () => {
		expect(codes(run(HIRING))).toContain("APPSHELL_NAV_STRAY");
	});
});

describe("the diagnostics' guide links point at real headings", () => {
	it("every rule anchor equals the slug of the heading in the guide", () => {
		const guide = readFileSync(join(root, "docs/appshell-navigation-contract.md"), "utf8");
		const headings = guide.split("\n").filter((l) => /^### \d+\./.test(l)).map((l) => anchorFor(l.replace(/^### /, "")));
		const out = [...run(HIRING).diagnostics, ...run(shellWith("<Home />", "nav={[{label:'H',href:'/'},{label:'C',href:'/c'}]} renderTopbar={(c) => <header />}")).diagnostics];
		expect(out.length).toBeGreaterThan(2);
		for (const d of out) expect(headings, d.code).toContain(d.docs.slice(GUIDE_URL.length + 1));
	});
	it("the contract's own examples pass the check", () => {
		const guide = readFileSync(join(root, "docs/appshell-navigation-contract.md"), "utf8");
		const blocks = [...guide.matchAll(/```tsx\n([\s\S]*?)```/g)].map((m) => m[1]);
		expect(blocks.length).toBe(2);
		const out = analyzeSources(blocks.map((text, i) => ({ file: `example-${i}.tsx`, text })));
		expect(out.shells).toBeGreaterThanOrEqual(1);
		expect(out.diagnostics).toEqual([]);
	});
});

describe("the command line", () => {
	const dirs = [];
	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});
	function project(files) {
		const dir = mkdtempSync(join(tmpdir(), "pags-appshell-"));
		dirs.push(dir);
		for (const [name, text] of Object.entries(files)) {
			mkdirSync(join(dir, name, ".."), { recursive: true });
			writeFileSync(join(dir, name), text);
		}
		return dir;
	}
	const cli = (dir, ...args) => spawnSync(process.execPath, [join(root, "scripts/check-appshell-navigation.mjs"), ...args], { cwd: dir, encoding: "utf8" });

	it("exits 1 and prints the diagnostic and guide link for the Hiring shape", () => {
		const r = cli(project({ "src/App.tsx": HIRING }));
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("APPSHELL_NAV_STRAY");
		expect(r.stdout).toContain(GUIDE_URL);
		expect(r.stdout).toContain("src/App.tsx");
	});
	it("exits 0 for a clean app, and says so", () => {
		const r = cli(project({ "src/App.tsx": shellWith("<Home />") }));
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("nothing the navigation contract names was found");
	});
	it("says plainly when it found no shell at all, rather than reporting clean", () => {
		const r = cli(project({ "src/main.ts": "export const x = 1;" }));
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("No ProShell/AppShell found");
	});
	it("--strict turns a warning into a failure; --json is machine-readable; node_modules is not scanned", () => {
		const warnOnly = "const NAV=[{label:'W',href:'/w'}]; const A = () => <ProShell app={a} nav={NAV}><Routes><Route path='/a' /><Route path='/b' /><Route path='/c' /></Routes></ProShell>;";
		const dir = project({ "src/App.tsx": warnOnly, "node_modules/pkg/bad.tsx": HIRING });
		expect(cli(dir).status).toBe(0);
		expect(cli(dir, "--strict").status).toBe(1);
		const j = JSON.parse(cli(dir, "--json").stdout);
		expect(j.shells).toBe(1);
		expect(j.diagnostics.map((d) => d.code)).toEqual(["APPSHELL_NAV_INCOMPLETE"]);
	});
});
