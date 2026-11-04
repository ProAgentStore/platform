import type { BrowserContext, Page } from "playwright";
import { expect, it } from "vitest";
import { BrowserStateSampler } from "./browser-state.js";
it("bounds the tab inventory explicitly and redacts short secrets before caching titles", () => {
 const pages = Array.from({ length: 22 }, (_, i) => ({ isClosed: () => false, url: () => `https://site.test/page-${i}?token=hidden` }) as Page);
 const context = { pages: () => pages } as BrowserContext;
 const sampler = new BrowserStateSampler(() => ["42"]);
 sampler.observe("### Page\n- Page URL: https://site.test/page-0\n- Page Title: PIN 42\n### Snapshot\n- heading test", context, pages[0]);
 const state = sampler.sample(context, pages[0], pages[0], null);
 expect(state).toMatchObject({ tabCount: 22, tabsTruncated: true, selection: "aligned" });
 expect(state.tabs).toHaveLength(20);
 expect(state.tabs[0]).toMatchObject({ title: "PIN [REDACTED]", url: "https://site.test/page-0" });
 expect(JSON.stringify(state)).not.toContain("token=hidden");
});
it("preserves public URL origin and path segments while removing embedded credentials before title clipping", () => {
 const clean = "https://jobs.example.test/oneclick-ui/company/EXAMPLE/publication/12345678-1234-1234-1234-123456789abc";
 const raw = `${clean}?seek-token=${"SYNTHETIC_TOKEN".repeat(20)}#PRIVATE`;
 const page = { isClosed: () => false, url: () => raw } as Page;
 const context = { pages: () => [page] } as BrowserContext;
 const sampler = new BrowserStateSampler(() => []);
 sampler.observe(`### Page\n- Page Title: Loading ${raw}`, context, page);
 const observed = sampler.sample(context, page, page, null);
 expect(observed.tabs[0]).toMatchObject({ url: clean, title: `Loading ${clean}` });
 expect(JSON.stringify(observed)).not.toMatch(/SYNTHETIC_|seek-token|PRIVATE/);
});
it("still masks known path credentials and generic tokens within one segment", () => {
 const raw = `https://user:password@jobs.test/reset/known%20secret/${"A".repeat(48)}?token=PRIVATE`;
 const page = { isClosed: () => false, url: () => raw } as Page;
 const context = { pages: () => [page] } as BrowserContext;
 const sampler = new BrowserStateSampler(() => ["known secret"]);
 sampler.observe(`### Page\n- Page Title: Loading ${raw}`, context, page);
 const observed = sampler.sample(context, page, page, null);
 expect(observed.tabs[0]).toMatchObject({ url: "https://jobs.test/reset/[REDACTED]/[REDACTED]", title: "Loading https://jobs.test/reset/[REDACTED]/[REDACTED]" });
 expect(JSON.stringify(observed)).not.toMatch(/password|known(?:%20| )secret|AAAA|PRIVATE/);
});
