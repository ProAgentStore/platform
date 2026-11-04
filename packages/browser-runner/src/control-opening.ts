import type { Page } from "playwright";

/** Execution evidence only: no navigation observed during this dispatch, not proof a popup opened. */
export interface ControlOpeningReceipt { sameDocument: boolean }
export async function observeControlOpening<T extends object>(page: Page | null | undefined, currentPage: () => Page | null | undefined, dispatch: () => Promise<T>): Promise<T & { controlOpening: ControlOpeningReceipt }> {
	if (!page || page.isClosed()) throw new Error("The combobox page is no longer available; no click was dispatched.");
	const context = page.context();
	let changed = false;
	const markChanged = () => { changed = true; };
	page.on("framenavigated", markChanged);page.on("close", markChanged);context.on("page", markChanged);
	try {
		const result = await dispatch();
		return { ...result, controlOpening: { sameDocument: !changed && !page.isClosed() && currentPage() === page } };
	} finally {
		page.off("framenavigated", markChanged);page.off("close", markChanged);context.off("page", markChanged);
	}
}
