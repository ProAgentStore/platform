import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Locator, Page } from "playwright";
import { RunnerInputError } from "./errors.js";
import type { BrowserAction } from "./types.js";

/** Click an element through escalating fallbacks (provided by the runner). */
export type ClickRobustly = (page: Page, loc: Locator) => Promise<boolean>;

/**
 * Enter text and VERIFY it actually took, escalating through the best-practice ladder
 * for masked / framework-controlled inputs (intl-tel, React-controlled, etc.):
 *   1) fill()  2) pressSequentially() + blur()  3) native value setter + dispatch events.
 * Returns true once the field holds the value. Generic — no site/widget-specific logic.
 */
async function typeRobustly(loc: Locator, text: string): Promise<boolean> {
	const norm = (s: string) => s.replace(/\s+/g, "");
	const took = async (): Promise<boolean> => {
		const v = await loc.inputValue({ timeout: 1_500 }).catch(() => null);
		if (v == null) return false;
		return v === text || norm(v) === norm(text) || (norm(text).length > 3 && norm(v).includes(norm(text)));
	};
	// 1. Playwright fill — fires input/change for most inputs.
	if (await loc.fill(text, { timeout: 6_000 }).then(() => true).catch(() => false)) {
		if (await took()) return true;
	}
	// 2. Real per-character typing + blur — for masks/typeaheads that only validate on key events.
	try {
		await loc.click({ timeout: 3_000 });
		await loc.fill("", { timeout: 2_000 }).catch(() => undefined); // clear first
		await loc.pressSequentially(text, { delay: 25, timeout: 8_000 });
		await loc.blur().catch(() => undefined);
		if (await took()) return true;
	} catch {
		/* fall through */
	}
	// 3. Native value setter + dispatched events — for React/Vue-controlled inputs where
	//    fill() sets the DOM value but the framework's onChange never fires.
	try {
		await loc.evaluate((el, val) => {
			const input = el as HTMLInputElement | HTMLTextAreaElement;
			const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
			const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
			if (setter) setter.call(input, val);
			else input.value = val;
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(new Event("change", { bubbles: true }));
			input.dispatchEvent(new Event("blur", { bubbles: true }));
		}, text);
		if (await took()) return true;
	} catch {
		/* fall through */
	}
	return false;
}

/**
 * Execute one selector-free browser action — address by ARIA role + accessible
 * name, with robust fallbacks for custom comboboxes, typeaheads, fuzzy <select>
 * matches, hidden checkboxes, and hidden file inputs. Pure over `page`; the
 * runner passes its clickRobustly helper. The caller handles post-action settle.
 */
export async function performBrowserAction(page: Page, action: BrowserAction, clickRobustly: ClickRobustly, resumeFile?: string | null): Promise<void> {
	const locate = () => {
		// Prefer the stable snapshot ref (aria-ref) — points at the exact element, so two
		// fields sharing a label (e.g. a phone "Country" code and an address "Country")
		// are never confused. Fall back to role+name for older snapshots.
		if (action.ref) return page.locator(`aria-ref=${action.ref}`);
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
			// Verified ladder (fill → pressSequentially+blur → setter+dispatch) — makes the
			// value actually take on masked / framework-controlled inputs.
			if (await typeRobustly(loc, text)) break;
			// The field may be a combobox or typeahead rather than a bare textbox.
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
				// Custom dropdowns render options async/with animation — WAIT for the list
				// to appear before clicking (else you click an overlay or nothing).
				await page.locator('[role="option"], [role="listbox"] li, ul[role="listbox"] > *').first().waitFor({ state: "visible", timeout: 2_000 }).catch(() => undefined);
				const opt = page.getByRole("option", { name: value, exact: false }).first();
				if ((await opt.count().catch(() => 0)) > 0) return opt.click({ timeout: 2_500 }).then(() => true).catch(() => false);
				// Fallback: any visible option/li whose text contains the value.
				const alt = page.locator('[role="option"], li').filter({ hasText: value }).first();
				if ((await alt.count().catch(() => 0)) > 0) return alt.click({ timeout: 2_500 }).then(() => true).catch(() => false);
				return false;
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

/**
 * After a WRITE action (type/select/check), read back what the field actually
 * holds now + any validation error rendered near it. This is the semantic
 * feedback the brain otherwise lacks: `fill()` succeeding doesn't mean the value
 * "took" (masked/intl widgets concatenate; validators reject a format). Returns a
 * short human string for the action log, or "" when there's nothing notable.
 * Never throws.
 */
export async function inspectField(page: Page, action: BrowserAction): Promise<string> {
	if (action.action !== "type" && action.action !== "select" && action.action !== "check") return "";
	if (!action.name && !action.ref) return "";
	try {
		const role = action.role as Parameters<Page["getByRole"]>[0] | undefined;
		let loc = action.ref
			? page.locator(`aria-ref=${action.ref}`)
			: role
				? page.getByRole(role, action.name ? { name: action.name } : undefined)
				: page.getByText(action.name ?? "", { exact: false });
		if (!action.ref) loc = typeof action.nth === "number" ? loc.nth(action.nth) : loc.first();
		const el = await loc.elementHandle({ timeout: 1_500 }).catch(() => null);
		if (!el) return "";
		const info = await el
			.evaluate((node) => {
				const e = node as HTMLElement & { value?: string };
				const raw = typeof e.value === "string" ? e.value : (e.getAttribute("aria-checked") ?? e.textContent ?? "");
				const value = String(raw).trim().slice(0, 120);
				const invalid = e.getAttribute("aria-invalid") === "true" || (typeof e.matches === "function" && e.matches(":invalid"));
				let err = "";
				const rx = /invalid|required|must|valid|error|format|enter a|please/i;
				const describedby = e.getAttribute("aria-describedby");
				if (describedby) {
					for (const id of describedby.split(/\s+/)) {
						const d = document.getElementById(id);
						const t = (d?.textContent || "").trim();
						if (t && rx.test(t)) { err = t; break; }
					}
				}
				if (!err) {
					const scope = e.closest("[class*=field], [class*=form-group], [class*=form-item], fieldset") || e.parentElement;
					const cand = scope?.querySelector('[role="alert"], [class*=error i], [class*=invalid i], [class*=danger i], [class*=help-block i]');
					const t = (cand?.textContent || "").trim();
					if (t && rx.test(t) && t.length < 180) err = t;
				}
				const disabled = e.hasAttribute("disabled") || e.getAttribute("aria-disabled") === "true" || e.hasAttribute("readonly");
				return { value, invalid, err: err.replace(/\s+/g, " ").slice(0, 180), tag: e.tagName.toLowerCase(), html: (e.outerHTML || "").replace(/\s+/g, " ").slice(0, 500), disabled };
			})
			.catch(() => null);
		if (!info) return "";
		const typed = String(action.text ?? "").trim();
		const stuck = !!typed && info.value === typed; // our value actually took
		const parts: string[] = [];
		// Report the field's real value when it differs from what we sent, or when the
		// field is authoritatively invalid.
		if (info.value && (info.invalid || !stuck)) {
			parts.push(`"${action.name}" now reads "${info.value}"${typed && info.value !== typed ? ` (you sent "${typed}")` : ""}`);
		}
		// Flag REJECTED ONLY on an authoritative per-field signal (aria-invalid / :invalid)
		// or when our value clearly did NOT take. A nearby error while the value stuck is
		// often stale (widgets show a "format" error mid-type that clears on blur/submit)
		// or belongs to another field — reporting it as REJECTED sent the brain into a
		// false-retry loop on a value that was actually accepted.
		if (info.invalid || (typed && !stuck)) {
			if (info.disabled) {
				// A disabled/read-only control can't be changed — it's almost always already
				// set correctly. Tell the brain to move on instead of fixating on it.
				parts.unshift(`ℹ "${action.name}" is DISABLED / read-only — it is likely already set correctly; do NOT keep trying, move on to other fields.`);
			} else {
				if (info.err) parts.unshift(`⚠ "${action.name}" REJECTED: "${info.err}"`);
				else if (info.invalid) parts.unshift(`⚠ "${action.name}" is marked invalid`);
				// Value didn't take / field invalid → show the widget's real DOM so the brain
				// can pick the right interaction (custom dropdown → click to open + click the
				// option by text; masked input → a different shape) instead of blindly retrying.
				if (info.html) parts.push(`DOM: <${info.tag}> ${info.html}`);
			}
		}
		return parts.join("; ");
	} catch {
		return "";
	}
}
