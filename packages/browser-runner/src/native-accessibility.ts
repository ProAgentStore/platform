import type { Page } from "playwright";

/** Trusted bridge constraint, never part of the browser tool's model-supplied arguments. */
export interface ExpectedAccessibility {
	role: "option";
	name: string;
}

/** Read native accessibility semantics without taking a snapshot or changing its reference registry. */
export async function accessibleTargetRefusal(currentPage: () => Page | null | undefined, ref: unknown, expected: ExpectedAccessibility): Promise<string | null> {
	const refused = "The observed option no longer matches the requested accessible name on this page and frame. Take a fresh snapshot; no click was dispatched.";
	const page = currentPage();
	if (!page || page.isClosed() || typeof ref !== "string" || !/^(?:f\d+)?e\d+$/.test(ref) || expected.role !== "option" || typeof expected.name !== "string" || !expected.name.trim()) return refused;
	let element: Awaited<ReturnType<ReturnType<Page["getByRef"]>["elementHandle"]>> | null = null;
	try {
		element = await page.getByRef(ref).elementHandle({ timeout: 1_000 });
		const frame = await element?.ownerFrame();
		if (!element || !frame || frame.isDetached() || frame.page() !== page) return refused;
		const url = frame.url();
		const observed = frame.locator(`aria-ref=${ref}`);
		const matching = observed.and(frame.getByRole(expected.role, { name: expected.name, exact: true }));
		if (await matching.count() !== 1) return refused;
		const submits = await matching.evaluate((node) => {
			const control = node.closest("button,input") as HTMLButtonElement | HTMLInputElement | null;
			if (!control?.form) return false;
			return control.tagName === "BUTTON" ? !["button", "reset"].includes(control.type) : ["submit", "image"].includes(control.type);
		});
		if (submits) return refused;
		if (!await matching.evaluate((node, original) => node === original, element, { timeout: 1_000 })) return refused;
		return currentPage() === page && !page.isClosed() && !frame.isDetached() && frame.url() === url ? null : refused;
	} catch { return refused; }
	finally { await element?.dispose().catch(() => undefined); }
}
