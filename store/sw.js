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

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const target = (event.notification.data && event.notification.data.url) || "/console/";
	event.waitUntil(
		(async () => {
			const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			for (const client of clientList) {
				if (client.url.includes("/console") && "focus" in client) {
					try {
						await client.navigate(target);
					} catch (_e) {
						/* navigation may be blocked cross-origin; focus anyway */
					}
					return client.focus();
				}
			}
			if (self.clients.openWindow) return self.clients.openWindow(target);
		})(),
	);
});
