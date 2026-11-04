import type { FileChooser } from "playwright";

/** Native facts from the exact bound input; receiving-site semantics belong to the model. */
export async function observeUploadSelection(input: ReturnType<FileChooser["element"]>, expected: string[]) {
	const handle = await input.evaluateHandle((element, names) => {
		const el = element as HTMLInputElement;
		const doc = el.ownerDocument;
		const view = doc.defaultView;
		const files = () => Array.from(el.files ?? [], (file) => file.name).sort();
		const matches = (actual: string[]) => JSON.stringify(actual) === JSON.stringify(names);
		let selected = false;
		const onSelection = (event: Event) => {
			if ((event.composedPath()[0] ?? event.target) === el && matches(files())) selected = true;
		};
		view?.addEventListener("input", onSelection, true);
		view?.addEventListener("change", onSelection, true);
		return {
			read: () => {
				const message = el.validationMessage;
				const limit = 2000;
				const marker = `\n[TRUNCATED: native validation message has ${message.length} characters]`;
				const validationMessage = message.length > limit ? `${message.slice(0, limit - marker.length)}${marker}` : message;
				return { connected: el.isConnected, files: files(), selected, ariaInvalid: el.getAttribute("aria-invalid") === "true", nativeValid: el.validity.valid, customError: el.validity.customError, validationMessage };
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
