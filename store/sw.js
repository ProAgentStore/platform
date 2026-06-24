// ProAgentStore service worker — PWA + Web Push. (v1 — push + PWA)
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
		self.registration.showNotification(data.title || "ProAgentStore", {
			body: data.body || "",
			icon: "/icon-192.png",
			badge: "/icon-192.png",
			tag: data.tag || "pags",
			data: { url: data.url || "/console/" },
			requireInteraction: true,
			vibrate: [120, 60, 120],
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
