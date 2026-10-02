import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIRMATION_WINDOW_MS, withinConfirmationWindow } from "./confirmation-window.js";

afterEach(() => vi.useRealTimers());

describe("machine confirmation window (#887)", () => {
	it("preserves a confirmed answer and clears the deadline", async () => {
		vi.useFakeTimers();
		const keepAlive = vi.fn();
		expect(await withinConfirmationWindow(Promise.resolve({ attached: true }), () => ({ attached: false }), keepAlive)).toEqual({ attached: true });
		expect(keepAlive).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("returns the known partial outcome while the mutation keeps running", async () => {
		vi.useFakeTimers();
		let finish!: (value: { unconfirmed: boolean }) => void;
		const operation = new Promise<{ unconfirmed: boolean }>((resolve) => { finish = resolve; });
		const keepAlive = vi.fn();
		const result = withinConfirmationWindow(operation, () => ({ unconfirmed: true }), keepAlive);
		await vi.advanceTimersByTimeAsync(CONFIRMATION_WINDOW_MS);
		expect(await result).toEqual({ unconfirmed: true });
		finish({ unconfirmed: false });
		await expect(keepAlive.mock.calls[0][0]).resolves.toEqual({ unconfirmed: false });
	});

	it("preserves definite failures rather than turning them into partial success", async () => {
		const error = new Error("attach refused");
		await expect(withinConfirmationWindow(Promise.reject(error), () => ({ unconfirmed: true }), vi.fn())).rejects.toBe(error);
	});
});
