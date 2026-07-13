import { useEffect, useRef, useState } from "react";
import { api, getToken, API } from "@proagentstore/sdk/client";
import { renderMd, mdLite, esc, escAttr, formatTime } from "@proagentstore/sdk/ui";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — dynamic surface loader.
//
// Lets an agent ship its OWN UI as a published bundle instead of hardcoding it
// into the console. A surface bundle is an ESM module that exports:
//
//   export function mount(ctx: SurfaceMountContext): undefined | (() => void)
//
// It renders into ctx.el and returns an optional cleanup function. The platform
// injects ctx.sdk (api/auth/markdown helpers) so the bundle never has to ship the
// client or worry about auth — and because it owns a plain DOM subtree, there's no
// React-version conflict (a creator may use vanilla JS or bundle their own
// framework inside that subtree). See ../../../PLAN-agent-os.md.
//
// SECURITY: a bundle runs in the console origin with the user's session token (via
// ctx.sdk.getToken/api). A creator-supplied cross-origin URL would therefore be
// arbitrary JS executing AS the viewing user → account/BYOK-key takeover. So we load
// ONLY same-origin bundles (surfaces ship from the platform itself, e.g.
// /console/surfaces/notes.js). Until bundles are isolated in a sandboxed iframe, this
// same-origin gate is the security boundary — do not loosen it to accept creator URLs.
// ─────────────────────────────────────────────────────────────────────────────

/** A surface bundle runs with the user's session token, so it must be served from the
 *  platform's own origin — never a creator-controlled host. */
function isSameOriginBundle(bundleUrl: string): boolean {
	try {
		return new URL(bundleUrl, window.location.href).origin === window.location.origin;
	} catch {
		return false;
	}
}

export interface SurfaceSdk {
	api: typeof api;
	getToken: typeof getToken;
	apiBase: string;
	renderMd: typeof renderMd;
	mdLite: typeof mdLite;
	esc: typeof esc;
	escAttr: typeof escAttr;
	formatTime: typeof formatTime;
}

export interface SurfaceMountContext {
	/** The element to render into (the platform owns its lifecycle). */
	el: HTMLElement;
	instanceId: string;
	sessionId?: string;
	sdk: SurfaceSdk;
}

type SurfaceModule = {
	mount?: (ctx: SurfaceMountContext) => undefined | (() => void);
};

const sdk: SurfaceSdk = { api, getToken, apiBase: API, renderMd, mdLite, esc, escAttr, formatTime };

export default function DynamicSurface({ bundleUrl, instanceId, sessionId }: {
	bundleUrl: string;
	instanceId: string;
	sessionId?: string;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;
		let unmount: undefined | (() => void);
		setError("");
		setLoading(true);
		// Refuse a cross-origin bundle BEFORE importing it — a creator-hosted script would
		// run with the viewer's session token (account takeover). See the SECURITY note above.
		if (!isSameOriginBundle(bundleUrl)) {
			setError("This surface can't be loaded — its bundle isn't hosted on the platform.");
			setLoading(false);
			return;
		}
		(async () => {
			try {
				const mod = (await import(/* @vite-ignore */ bundleUrl)) as SurfaceModule;
				if (cancelled || !ref.current) return;
				if (typeof mod.mount !== "function") {
					setError("This surface bundle has no mount() export.");
					return;
				}
				unmount = mod.mount({ el: ref.current, instanceId, sessionId, sdk });
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
			try { (unmount as (() => void) | undefined)?.(); } catch { /* surface cleanup threw */ }
			// Surfaces own their subtree; clear it so a remount starts clean.
			if (ref.current) ref.current.innerHTML = "";
		};
	}, [bundleUrl, instanceId, sessionId]);

	if (error) {
		return <div className="text-sm text-red p-4">Couldn't load this agent's surface — {error}</div>;
	}
	return (
		<div className="h-full min-h-0">
			{loading && <div className="text-sm text-muted p-4">Loading surface…</div>}
			<div ref={ref} className="h-full min-h-0" />
		</div>
	);
}
