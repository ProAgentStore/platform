import { useEffect, useRef, useState } from "react";
import { api, getToken, API } from "@proagentstore/sdk/client";
import { renderMd, mdLite, esc, escAttr, formatTime } from "@proagentstore/sdk/ui";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — dynamic surface loader.
//
// Lets an agent ship its OWN UI as a published bundle instead of hardcoding it
// into the console. A surface bundle is an ESM module that exports:
//
//   export function mount(ctx: SurfaceMountContext): void | (() => void)
//
// It renders into ctx.el and returns an optional cleanup function. The platform
// injects ctx.sdk (api/auth/markdown helpers) so the bundle never has to ship the
// client or worry about auth — and because it owns a plain DOM subtree, there's no
// React-version conflict (a creator may use vanilla JS or bundle their own
// framework inside that subtree). See ../../../PLAN-agent-os.md.
//
// SECURITY: a bundle runs in the console origin with the user's session (via
// ctx.sdk.api). That's fine for first-party / trusted creators; untrusted bundles
// should later be isolated in a sandboxed iframe. Surfaces are declared in an
// instance's capabilities.customSurfaces by the platform, not user-supplied URLs.
// ─────────────────────────────────────────────────────────────────────────────

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
	mount?: (ctx: SurfaceMountContext) => void | (() => void);
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
		let unmount: void | (() => void);
		setError("");
		setLoading(true);
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
