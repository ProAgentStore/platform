import type { BrowserContext, Page } from "playwright";
import type { BrowserStateSnapshot } from "./browser-state-contract.js";
import { redactText } from "./local-browser/contract.js";

/** Reads only cached native metadata; never selects a tab, runs page JS, or attaches dialog listeners. */
export class BrowserStateSampler {
 private readonly ids = new WeakMap<Page, string>();
 private readonly titles = new WeakMap<Page, string>();
 private readonly dialogs = new WeakMap<Page, BrowserStateSnapshot["dialog"]>();
 constructor(private readonly secrets: () => readonly string[]) {}
 private id(page: Page | undefined | null): string | null {
  if (!page || page.isClosed()) return null;
  let id = this.ids.get(page);
  if (!id) { id = crypto.randomUUID(); this.ids.set(page, id); }
  return id;
 }
 private safe(value: string, max: number): string {
  for (const secret of this.secrets()) if (secret) for (const variant of new Set([secret, encodeURIComponent(secret)])) value = value.split(variant).join("[REDACTED]");
  const safe = redactText(value);
  return safe.length > max ? `${safe.slice(0, max - 1)}…` : safe;
 }
 private url(page: Page): string {
  try {
   const raw = page.url();
   if (raw === "about:blank") return raw;
   const url = new URL(raw);
   return url.protocol === "https:" || url.protocol === "http:" ? this.safe(`${url.origin}${url.pathname}`, 2000) : "[non-web URL]";
  } catch { return "[unavailable]"; }
 }
 /** Consume metadata already returned by MCP. Text supplied by a page is never executed. */
 observe(text: string, context: BrowserContext | undefined, selected: Page | undefined): void {
  if (!context || !selected || selected.isClosed()) return;
  const title = text.match(/^### Page\n(?:[^\n]*\n)*?- Page Title: ([^\n]*)/m)?.[1];
  if (title !== undefined) this.titles.set(selected, this.safe(title, 200));
  const section = text.match(/^### Open tabs\n([\s\S]*?)(?=^### |$(?![\s\S]))/m)?.[1];
  for (const line of section?.split("\n") ?? []) {
   const match = line.match(/^- (\d+):(?: \(current\))? \[(.*)\]\(([^\n]*)\)$/);
   const page = match ? context.pages()[Number(match[1])] : undefined;
   if (page && match && page.url() === match[3]) this.titles.set(page, this.safe(match[2], 200));
  }
  const modal = text.match(/^### Modal state\n([\s\S]*?)(?=^### |$(?![\s\S]))/m)?.[1];
  const type = modal?.match(/"(alert|confirm|prompt|beforeunload)" dialog/)?.[1] as BrowserStateSnapshot["dialog"]["type"];
  this.dialogs.set(selected, type ? { status: "observed", type, observedAt: new Date().toISOString() } : { status: "unknown" });
 }
 sample(context: BrowserContext | undefined, active: Page | null | undefined, selected: Page | undefined, chooserId: string | null): BrowserStateSnapshot {
  const pages = context?.pages().filter((page) => !page.isClosed()) ?? [];
  const nativeActivePageId = this.id(active), mcpSelectedPageId = this.id(selected);
  const tabs = pages.slice(0, 20).map((page, index) => ({ pageId: this.id(page)!, index, url: this.url(page), ...(this.titles.has(page) ? { title: this.titles.get(page)! } : {}), nativeActive: page === active, mcpSelected: page === selected }));
  return { nativeActivePageId, mcpSelectedPageId, selection: !nativeActivePageId || !mcpSelectedPageId ? "unknown" : nativeActivePageId === mcpSelectedPageId ? "aligned" : "different", tabCount: pages.length, tabsTruncated: pages.length > tabs.length, tabs, pendingChooser: chooserId && nativeActivePageId ? { pageId: nativeActivePageId, chooserId } : null, dialog: selected ? this.dialogs.get(selected) ?? { status: "unknown" } : { status: "unknown" } };
 }
}
