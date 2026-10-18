/**
 * What leaves this machine from a terminal pane (#1166).
 *
 * A pane is whatever the owner's terminal shows: a token a tool printed, a password typed into a prompt
 * that echoed it, a secret `secure_input_inject` delivered. Every `/tmux/*` and `/terminal/*` answer
 * carrying a pane is passed through {@link redactPane} on its way out:
 *
 *   • `maskSecrets` — the ONE credential redactor, shared byte-identically with the CLI's crash reports
 *     and update log (`crash-reports.ts`), which also catches a two-part PAGS session token;
 *   • every value `secure_input_inject` delivered here, remembered for {@link INJECTED_TTL_MS} — found
 *     even where a long code wrapped across pane rows.
 *
 * And after an echoed delivery, `/secure/scrub` clears the tmux pane's scrollback, so the value is not
 * sitting in the history for the next reader. The visible screen is not cleared — a running program is
 * drawing it — which is what the masking is for.
 *
 * The one caller that must see a pane as it is — `secure_input_inject` confirming the value landed —
 * asks with `unmasked: true`; that pane goes to no model, log or trace (lib/secure-input-inject.ts).
 */
import type { ServerResponse } from "node:http";
import { maskSecrets } from "../crash-reports.js";
import { tmuxExec } from "./tmux.js";

/** How long a delivered value is masked in captures. */
export const INJECTED_TTL_MS = 24 * 60 * 60_000;
const MAX_REMEMBERED = 50;

const injected: Array<{ value: string; until: number }> = [];

/** Mask `value` in every capture from now on (for {@link INJECTED_TTL_MS}). Values under 4 characters are not maskable. */
export function rememberInjected(value: string, now = Date.now()): void {
	const v = value.trim();
	if (v.length < 4) return;
	injected.push({ value: v, until: now + INJECTED_TTL_MS });
	while (injected.length > MAX_REMEMBERED) injected.shift();
}

/** For tests. */
export function forgetInjected(): void {
	injected.length = 0;
}

/** Every remembered value in `text`, replaced character for character with `•` — across line wraps too. */
export function maskInjected(text: string, now = Date.now()): string {
	const live = injected.filter((e) => e.until > now);
	if (!live.length || !text) return text;
	// Search the text with its newlines removed, then mask the ORIGINAL positions, so a value tmux wrapped
	// onto the next row is still found and the pane keeps its shape.
	const at: number[] = [];
	let flat = "";
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n" || text[i] === "\r") continue;
		at.push(i);
		flat += text[i];
	}
	const chars = text.split("");
	for (const { value } of live) {
		for (let i = flat.indexOf(value); i !== -1; i = flat.indexOf(value, i + value.length)) {
			for (let k = i; k < i + value.length; k++) chars[at[k]] = "•";
		}
	}
	return chars.join("");
}

/** A pane as it may leave this machine. */
export function redactPane(text: string, now = Date.now()): string {
	return maskInjected(maskSecrets(text), now);
}

const redacting = new WeakSet<ServerResponse>();

/** Mark this response's panes for redaction: a terminal route, unless the caller is inject confirming a delivery. */
export function redactPanesOf(res: ServerResponse, path: string, body: { unmasked?: unknown } | undefined): void {
	if ((path.startsWith("/tmux/") || path.startsWith("/terminal/")) && body?.unmasked !== true) redacting.add(res);
}

/** The body `json()` writes: its `pane`/`paneBefore` redacted when {@link redactPanesOf} marked the response. */
export function outgoing(res: ServerResponse, body: unknown): unknown {
	if (!redacting.has(res) || !body || typeof body !== "object") return body;
	const out = { ...(body as Record<string, unknown>) };
	for (const key of ["pane", "paneBefore"]) if (typeof out[key] === "string") out[key] = redactPane(out[key] as string);
	return out;
}

/**
 * `POST /secure/scrub {target, value}`: after an echoed delivery, remember the value for masking and clear
 * the tmux pane's scrollback. `cleared` is false for a non-tmux backend, whose history this cannot reach.
 */
export function scrubDelivered(body: { target?: unknown; value?: unknown }): { remembered: boolean; cleared: boolean } {
	const value = typeof body.value === "string" ? body.value : "";
	const target = typeof body.target === "string" ? body.target.trim() : "";
	if (!value || !target) return { remembered: false, cleared: false };
	rememberInjected(value);
	const tmuxTarget = /^tmux:/i.test(target) ? target.slice(5) : /^(kitty|iterm2):/i.test(target) ? "" : target;
	if (!tmuxTarget) return { remembered: true, cleared: false };
	try {
		tmuxExec(["clear-history", "-t", tmuxTarget]);
		return { remembered: true, cleared: true };
	} catch {
		return { remembered: true, cleared: false };
	}
}
