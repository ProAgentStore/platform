/** Relay control-plane IO has a finite owner even if fetch/body parsing never cooperates (#1555, #1556). */
import { requestPags, requestRunner } from "./http.js";
import type { PagsRequestOptions, RunnerRequestOptions } from "./types.js";
export const relayIoLimits = { requestMs: 15_000, mintMs: 15_000, openingMs: 20_000 };

export async function boundedRelayWork<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, parent?: AbortSignal): Promise<T> {
	parent?.throwIfAborted();
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		const abandoned = new Promise<never>((_, reject) => {
			onAbort = () => { controller.abort(parent?.reason ?? new Error("Relay operation closed")); reject(controller.signal.reason); };
			if (parent?.aborted) { onAbort(); return; }
			parent?.addEventListener("abort", onAbort, { once: true });
			timer = setTimeout(() => {
				const error = new Error(`Relay control-plane request did not finish within ${ms / 1000}s`);
				controller.abort(error); reject(error);
			}, ms);
			timer.unref?.();
		});
		controller.signal.throwIfAborted();
		const value = await Promise.race([work(controller.signal), abandoned]);
		controller.signal.throwIfAborted();
		return value;
	} finally {
		if (timer) clearTimeout(timer);
		if (onAbort) parent?.removeEventListener("abort", onAbort);
	}
}

export function relayRequest<T>(method: string, path: string, opts: PagsRequestOptions, body?: unknown, signal?: AbortSignal): Promise<T> {
	return boundedRelayWork((bounded) => requestPags<T>(method, path, opts, body, bounded), relayIoLimits.requestMs, signal);
}

export function relayRunnerRequest<T>(method: string, path: string, opts: RunnerRequestOptions, body?: unknown, signal?: AbortSignal): Promise<T> {
	return boundedRelayWork((bounded) => requestRunner<T>(method, path, opts, body, bounded), relayIoLimits.requestMs, signal);
}
