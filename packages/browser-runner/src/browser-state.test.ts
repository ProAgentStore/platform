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
