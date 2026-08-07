// ProAgentStore service worker — PWA + Web Push. (v2 — push + PWA, in-app handoff)
// Shows a notification when an agent needs you (e.g. a CAPTCHA handoff) and
// deep-links straight into the console / takeover on tap.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
	let data = { title: "ProAgentStore", body: "You have a new notification", url: "/console/" };
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
			const onSite = clients.filter((c) => c.visibilityState === "visible" && c.url.includes("/console"));
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
				data: { url: data.url || "/console/" },
				requireInteraction: true,
				vibrate: [120, 60, 120],
			});
		}),
	);
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
 * The `/console` match covers every route of the SPA — /usage and /preferences included, which
 * is intended: they are the app, and a deep link is meant to move whichever tab it is in.
 */
self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const target = event.notification.data?.url || "/console/";
	event.waitUntil(
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
					if (!client.url.includes("/console") || !("focus" in client)) continue;
					try {
						await client.navigate(target);
						return client.focus();
					} catch (_e) {
						break; // the tab could not be moved — open a window instead of focusing a stale one
					}
				}
			}
			if (self.clients.openWindow) return self.clients.openWindow(target);
		})(),
	);
});
