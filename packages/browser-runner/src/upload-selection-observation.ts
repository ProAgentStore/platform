import type { FileChooser } from "playwright";

/** Observe the bound input before a SPA consumes it; filename text alone never proves selection. */
export async function observeUploadSelection(input: ReturnType<FileChooser["element"]>, expected: string[]) {
	const handle = await input.evaluateHandle((element, names) => {
		const el = element as HTMLInputElement;
		const doc = el.ownerDocument;
		const view = doc.defaultView;
		const files = () => Array.from(el.files ?? [], (file) => file.name).sort();
		const matches = (actual: string[]) => JSON.stringify(actual) === JSON.stringify(names);
		const visible = (node: Element | null): node is Element => {
			if (!node?.isConnected || !node.getClientRects().length) return false;
			for (let current: Element | null = node; current; current = current.parentElement) {
				const style = view?.getComputedStyle(current);
				if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse" || style?.opacity === "0") return false;
			}
			return true;
		};
		const filenames = () => {
			const found = new Set<string>();
			const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				const text = node.textContent?.trim() ?? "";
				if (names.includes(text) && visible(node.parentElement)) found.add(text);
			}
			return found;
		};
		const initialNames = filenames();
		const initialIds = `${el.getAttribute("aria-describedby") ?? ""} ${el.getAttribute("aria-errormessage") ?? ""}`.trim().split(/\s+/);
		let selected = false;
		const onSelection = (event: Event) => {
			if ((event.composedPath()[0] ?? event.target) === el && matches(files())) selected = true;
		};
		view?.addEventListener("input", onSelection, true);
		view?.addEventListener("change", onSelection, true);
		return {
			read: () => {
				// A replacement input may report rejection; it never supplies selection evidence.
				const replacement = !el.isConnected && el.id ? doc.getElementById(el.id) as HTMLInputElement | null : null;
				const invalid = (input: HTMLInputElement | null) => input?.getAttribute("aria-invalid") === "true" || !!input?.validity?.customError;
				const ids = [...initialIds, ...[el, replacement].flatMap((input) => `${input?.getAttribute("aria-describedby") ?? ""} ${input?.getAttribute("aria-errormessage") ?? ""}`.trim().split(/\s+/))];
				const linked = ids.map((id) => doc.getElementById(id)).filter((node) => visible(node) && node.getAttribute("role") === "alert");
				const rejection = /\b(error|invalid|unsupported|failed|rejected|cannot|exceeds?)\b|not (?:allowed|supported)|too (?:large|big)|could not/i;
				const alerts = [...linked, ...Array.from(doc.querySelectorAll('[role="alert"]')).filter((node) => visible(node) && rejection.test(node.textContent ?? ""))].map((node) => node?.textContent?.trim() ?? "").filter(Boolean);
				const currentNames = filenames();
				return { connected: el.isConnected, files: files(), invalid: invalid(el) || invalid(replacement), alerts, selected, newFilenameAcknowledgment: names.every((name) => !initialNames.has(name) && currentNames.has(name)) };
			},
			dispose: () => { view?.removeEventListener("input", onSelection, true); view?.removeEventListener("change", onSelection, true); },
		};
	}, expected);
	let disposed = false;
	return {
		read: () => handle.evaluate((observation) => observation.read()),
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			await handle.evaluate((observation) => observation.dispose()).catch(() => undefined);
			await handle.dispose().catch(() => undefined);
		},
	};
}
