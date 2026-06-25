import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Locator, Page } from "playwright";
import { RunnerInputError } from "./errors.js";
import type { BrowserAction } from "./types.js";

/** Click an element through escalating fallbacks (provided by the runner). */
export type ClickRobustly = (page: Page, loc: Locator) => Promise<boolean>;

/**
 * Execute one selector-free browser action — address by ARIA role + accessible
 * name, with robust fallbacks for custom comboboxes, typeaheads, fuzzy <select>
 * matches, hidden checkboxes, and hidden file inputs. Pure over `page`; the
 * runner passes its clickRobustly helper. The caller handles post-action settle.
 */
export async function performBrowserAction(page: Page, action: BrowserAction, clickRobustly: ClickRobustly, resumeFile?: string | null): Promise<void> {
	const locate = () => {
		const role = action.role as Parameters<Page["getByRole"]>[0] | undefined;
		let loc = role
			? page.getByRole(role, action.name ? { name: action.name } : undefined)
			: page.getByText(action.name ?? "", { exact: false });
		loc = typeof action.nth === "number" ? loc.nth(action.nth) : loc.first();
		return loc;
	};
	switch (action.action) {
		case "navigate":
			if (!action.url || !/^https?:\/\//.test(action.url)) throw new RunnerInputError("navigate requires an http(s) url");
			await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
			break;
		case "type": {
			const text = String(action.text ?? "");
			const loc = locate();
			// Plain fill, then combobox/label fill (the field may be a combobox or
			// typeahead, not a bare textbox), then click + keyboard type (typeaheads).
			if (await loc.fill(text, { timeout: 6_000 }).then(() => true).catch(() => false)) break;
			if (action.name && (await page.getByRole("combobox", { name: action.name }).fill(text, { timeout: 3_000 }).then(() => true).catch(() => false))) break;
			if (action.name && (await page.getByLabel(action.name).fill(text, { timeout: 3_000 }).then(() => true).catch(() => false))) break;
			await clickRobustly(page, loc);
			await page.keyboard.type(text, { delay: 15 }).catch(() => undefined);
			break;
		}
		case "click":
			if (!(await clickRobustly(page, locate()))) throw new RunnerInputError("could not click the target");
			break;
		case "select": {
			const value = String(action.text ?? "");
			const loc = locate();
			const pickOption = async () => {
				const opt = page.getByRole("option", { name: value, exact: false }).first();
				if ((await opt.count().catch(() => 0)) === 0) return false;
				return opt.click({ timeout: 2_500 }).then(() => true).catch(() => false);
			};
			// 1. Native <select>: exact label/value, then a fuzzy (case/punctuation
			//    -insensitive) match so "Decline to self-identify" hits the option
			//    "Decline To Self Identify".
			if (await loc.selectOption({ label: value }, { timeout: 4_000 }).then(() => true).catch(() => false)) break;
			if (await loc.selectOption(value, { timeout: 2_500 }).then(() => true).catch(() => false)) break;
			const fuzzy = await loc.evaluate((el, want) => {
				if (!(el instanceof HTMLSelectElement)) return false;
				const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
				const w = norm(want);
				const opt = Array.from(el.options).find((o) => { const t = norm(o.textContent || ""); return t === w || (w.length > 3 && (t.includes(w) || w.includes(t))); });
				if (!opt) return false;
				el.value = opt.value;
				el.dispatchEvent(new Event("input", { bubbles: true }));
				el.dispatchEvent(new Event("change", { bubbles: true }));
				return true;
			}, value).catch(() => false);
			if (fuzzy) break;
			// 2. Custom combobox / typeahead: open it, try a visible matching option.
			await clickRobustly(page, loc);
			await page.waitForTimeout(350).catch(() => undefined);
			if (await pickOption()) break;
			// 3. Typeahead: type to filter, then pick the suggestion — by click, else
			//    keyboard (ArrowDown+Enter), which beats clicking a dropdown that
			//    closes on blur.
			await page.keyboard.type(value, { delay: 15 }).catch(() => undefined);
			await page.waitForTimeout(550).catch(() => undefined);
			if (await pickOption()) break;
			await page.keyboard.press("ArrowDown").catch(() => undefined);
			await page.keyboard.press("Enter").catch(() => undefined);
			break;
		}
		case "check": {
			const loc = locate();
			// Custom checkboxes hide the real <input> (opacity:0 / behind a label /
			// a div[role=checkbox]). Try Playwright's check, then force, then a
			// direct DOM tick matched by the checkbox's label text.
			if (await loc.check({ timeout: 5_000 }).then(() => true).catch(() => false)) break;
			if (await loc.check({ force: true, timeout: 3_000 }).then(() => true).catch(() => false)) break;
			const ticked = await page
				.evaluate((rawName: string) => {
					const norm = (s: string | null | undefined) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
					const needle = norm(rawName).slice(0, 30);
					const boxes = Array.from(document.querySelectorAll<HTMLElement>('input[type="checkbox"], [role="checkbox"]'));
					const labelOf = (b: HTMLElement) => {
						const forId = b.id ? document.querySelector(`label[for="${b.id}"]`)?.textContent : "";
						return norm(b.closest("label")?.textContent || b.getAttribute("aria-label") || forId || b.parentElement?.textContent || "");
					};
					const tick = (b: HTMLElement) => {
						if (b instanceof HTMLInputElement) {
							b.checked = true;
							b.dispatchEvent(new Event("input", { bubbles: true }));
							b.dispatchEvent(new Event("change", { bubbles: true }));
						} else {
							b.setAttribute("aria-checked", "true");
						}
						b.click?.();
					};
					const match = boxes.find((b) => { const l = labelOf(b); return needle && (l.includes(needle) || (l.length > 12 && needle.includes(l.slice(0, 12)))); });
					const target = match || (boxes.length === 1 ? boxes[0] : undefined);
					if (!target) return false;
					tick(target);
					return true;
				}, action.name ?? "")
				.catch(() => false);
			if (ticked) break;
			if (!(await clickRobustly(page, locate()))) throw new RunnerInputError("could not find/tick the checkbox");
			break;
		}
		case "upload": {
			// Always attach via Playwright — never a native dialog. Handles both a
			// direct <input type=file> (set files on it) and a styled "Upload"
			// button that opens a native chooser (intercept the filechooser).
			// The LLM doesn't know the runner's local path, so prefer the résumé the
			// runner already resolved (downloaded from the platform); fall back to an
			// explicit action.file only if it's a real local file.
			const explicit = action.file ? resolve(String(action.file)) : "";
			const file = resumeFile && existsSync(resumeFile)
				? resumeFile
				: explicit && existsSync(explicit) ? explicit : "";
			if (!file) throw new RunnerInputError("no résumé available to upload — upload one in the console (Knowledge → Résumé)");
			let done = false;
			// 1. Label-associated input (some forms).
			if (action.name) {
				done = await page.getByLabel(action.name).setInputFiles(file, { timeout: 4_000 }).then(() => true).catch(() => false);
			}
			// 2. The real <input type=file> directly — most ATS (Greenhouse, Lever…)
			//    hide it behind a styled "Attach" button; setInputFiles works on a
			//    hidden input and fires the change event, no native dialog.
			if (!done) {
				done = await page.locator('input[type="file"]').first().setInputFiles(file, { timeout: 4_000 }).then(() => true).catch(() => false);
			}
			// 3. Styled uploader with no input at all: click the trigger + intercept
			//    the native file chooser.
			if (!done) {
				const chooserP = page.waitForEvent("filechooser", { timeout: 8_000 }).catch(() => null);
				await locate().click({ timeout: 8_000 }).catch(() => undefined);
				const chooser = await chooserP;
				if (chooser) await chooser.setFiles(file);
				else throw new RunnerInputError("no file upload control found for upload action");
			}
			break;
		}
		case "key":
			await page.keyboard.press(String(action.key ?? "Enter"));
			break;
		case "scroll":
			await page.mouse.wheel(0, action.dy ?? 600);
			break;
		case "wait":
			await page.waitForTimeout(Math.min(5_000, action.ms ?? 1_000));
			break;
		default: {
			const name = String((action as BrowserAction).action || "");
			// The brain sometimes invents click variants (triple_click / double_click
			// to select a field's text before retyping). Handle them generically
			// rather than failing the whole task — clickCount selects the text.
			if (/click/i.test(name)) {
				const loc = locate();
				const clickCount = /triple/i.test(name) ? 3 : /double|dbl/i.test(name) ? 2 : 1;
				if (!(await loc.click({ clickCount, timeout: 6_000 }).then(() => true).catch(() => false))) {
					await clickRobustly(page, loc);
				}
				break;
			}
			throw new RunnerInputError(
				`Unsupported action "${name}". Use one of: click, type, select, check, upload, navigate, scroll, key, wait. To clear or replace a field, use "type" — it overwrites the existing value.`,
			);
		}
	}
}
