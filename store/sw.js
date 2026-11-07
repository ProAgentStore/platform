// ProAgentStore service worker — PWA + Web Push. (v3 — push + PWA, in-app handoff, notification actions)
// Shows a notification when an agent needs you (e.g. a CAPTCHA handoff) and
// deep-links straight into the console / takeover on tap.

// On console.proagentstore.online the app is mounted at `/`; everywhere else at `/console` (App.tsx
// `consoleBasename`). Producers emit `/console/…` (workers/api/src/lib/console-links.ts), so on the
// console host the prefix comes off — the same rule as `notificationRoute` in
// store/console/src/lib/deepLink.ts, which a static SW cannot import. Without it every tap there
// navigated to a `/console/…` path the router does not have and landed on the home screen (#897).
const CONSOLE_HOST = "console.proagentstore.online";

/** Where a click opens. No link → the notification feed, never the bare home screen (#897). */
function clickTarget(url) {
	const target = url || "/console/notifications";
	if (self.location.hostname !== CONSOLE_HOST) return target;
	if (target === "/console" || target === "/console/") return "/";
	return target.startsWith("/console/") ? target.slice("/console".length) : target;
}

/** A tab showing the console on this origin — by path, not by `url.includes("/console")`, which
 *  matched the console host's NAME and nothing else there. */
function isConsoleTab(clientUrl) {
	try {
		const u = new URL(clientUrl);
		if (u.origin !== self.location.origin) return false;
		return self.location.hostname === CONSOLE_HOST || u.pathname === "/console" || u.pathname.startsWith("/console/");
	} catch (_e) {
		return false;
	}
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
	let data = { title: "ProAgentStore", body: "You have a new notification", url: "" };
	try {
		if (event.data) data = { ...data, ...event.data.json() };
	} catch (_e) {
		if (event.data) data.body = event.data.text();
	}
	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
			// Skip the OS notification if the user has a visible console tab — they are looking
			// at the app, so a system banner for something the app itself can show is redundant
			// (#176). The `/console` test covers every route: the SPA is mounted at base
			// `/console/` with a matching router basename.
			//
			// Hand the payload to those tabs instead of dropping it, so the bell badge updates
			// NOW rather than on its next poll. Suppressing a notification is only honest if the
			// app surfaces it; before this the push simply vanished.
			const onSite = clients.filter((c) => c.visibilityState === "visible" && isConsoleTab(c.url));
			if (onSite.length) {
				for (const c of onSite) {
					// Keep this string in step with PUSH_SUPPRESSED_MESSAGE in
					// store/console/src/lib/pushMessages.ts — a static SW cannot import it.
					try {
						c.postMessage({ type: "pags:push-suppressed", title: data.title, body: data.body, url: data.url, tag: data.tag });
					} catch (_e) {
						/* a client can go away between matchAll and postMessage */
					}
				}
				return;
			}
			return self.registration.showNotification(data.title || "ProAgentStore", {
				body: data.body || "",
				icon: "/icon-192.png",
				badge: "/icon-192.png",
				tag: data.tag || "pags",
				// Apply/Skip buttons (#1602) where the platform shows them; elsewhere (iOS) the tap still opens the lead.
				...(Array.isArray(data.actions) && data.actions.length ? { actions: data.actions } : {}),
				data: { url: data.url, leadAction: data.data?.leadAction },
				requireInteraction: true,
				vibrate: [120, 60, 120],
			});
		}),
	);
});

// Same origin the console's API client talks to (packages/sdk/src/client.ts).
const API = "https://api.proagentstore.online";

/**
 * Apply / Skip pressed on a job-lead decision push (#1602). The worker holds no session, so the push
 * carried one single-purpose token per button; the server makes the same compare-and-set triage the
 * Data tab does and says what happened, which is shown back as a confirmation. If the call cannot
 * be made at all, open the lead so the owner can decide there instead of losing the tap.
 */
async function decideLead(event, action) {
	const { url, leadAction } = event.notification.data || {};
	let result;
	try {
		const res = await fetch(`${API}/v1/push/lead-action`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: leadAction[action] }),
		});
		result = await res.json();
	} catch (_e) {
		return openTarget(clickTarget(url));
	}
	await self.registration.showNotification(result?.ok ? (action === "apply" ? "Applying" : "Skipped") : "Not changed", {
		body: result?.message || "",
		icon: "/icon-192.png",
		badge: "/icon-192.png",
		tag: `lead-action:${url}`,
		data: { url },
	});
}

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const action = event.action;
	if ((action === "apply" || action === "skip") && event.notification.data?.leadAction?.[action]) {
		event.waitUntil(decideLead(event, action));
		return;
	}
	event.waitUntil(openTarget(clickTarget(event.notification.data?.url)));
});

/**
 * Open what the notification is about (#338).
 *
 * `WindowClient.navigate()` is **same-origin only** by spec, so an off-origin target can never
 * move an already-open tab. That used to be caught and shrugged off ("focus anyway"), which is
 * not a fallback — it is a no-op indistinguishable from a broken notification, and it made the
 * bug intermittent: with no console tab open the same click reached `openWindow()`, where
 * cross-origin IS allowed, and worked. So an off-origin target skips the tab loop entirely, and
 * a navigate that rejects falls THROUGH to openWindow instead of focusing a tab that did not
 * move. (Producers should send a same-origin console path — see deployDeepLink.)
 *
 * `isConsoleTab` covers every route of the SPA — /usage and /preferences included, which is
 * intended: they are the app, and a deep link is meant to move whichever tab it is in.
 */
function openTarget(target) {
	return (
		(async () => {
			let sameOrigin = true;
			try {
				sameOrigin = new URL(target, self.location.origin).origin === self.location.origin;
			} catch (_e) {
				sameOrigin = false;
			}
			if (sameOrigin) {
				const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
				for (const client of clientList) {
					if (!isConsoleTab(client.url) || !("focus" in client)) continue;
					try {
						await client.navigate(target);
						return client.focus();
					} catch (_e) {
						break; // the tab could not be moved — open a window instead of focusing a stale one
					}
				}
			}
			if (self.clients.openWindow) return self.clients.openWindow(target);
		})()
	);
}
