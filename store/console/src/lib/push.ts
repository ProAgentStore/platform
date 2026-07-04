// Web-push enrolment for the console. The backend + service worker (/sw.js) were
// already in place; this is the missing piece that actually subscribes the user's
// browser so notifyUser() (e.g. "the apply agent needs your answer") reaches them
// as a real OS notification, not just a silent bell entry.
import { api } from "@proagentstore/sdk/client";

const SW_URL = "/sw.js";

function urlB64ToUint8Array(base64: string): Uint8Array {
	const padding = "=".repeat((4 - (base64.length % 4)) % 4);
	const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(b64);
	const arr = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
	return arr;
}

export function pushSupported(): boolean {
	return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** Current permission: "granted" | "denied" | "default" | "unsupported". */
export function pushPermission(): NotificationPermission | "unsupported" {
	return pushSupported() ? Notification.permission : "unsupported";
}

async function getRegistration(): Promise<ServiceWorkerRegistration> {
	return (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register(SW_URL, { scope: "/" }));
}

async function subscribeAndSave(reg: ServiceWorkerRegistration): Promise<boolean> {
	const { publicKey } = await api<{ publicKey: string | null }>("/v1/push/vapid-key");
	if (!publicKey) return false;
	const sub =
		(await reg.pushManager.getSubscription()) ??
		(await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(publicKey) as BufferSource }));
	await api("/v1/push/subscribe", { method: "POST", body: JSON.stringify(sub.toJSON()) });
	return true;
}

/** On load when signed in: if the user already granted permission, (re)register the
 *  SW and make sure a live subscription is saved server-side. Never prompts. */
export async function ensurePushSubscribed(): Promise<void> {
	if (!pushSupported() || Notification.permission !== "granted") return;
	try { await subscribeAndSave(await getRegistration()); } catch { /* best-effort */ }
}

/** User-gesture entry point: ask permission, then subscribe. */
export async function enablePush(): Promise<"granted" | "denied" | "unsupported" | "error"> {
	if (!pushSupported()) return "unsupported";
	try {
		const perm = await Notification.requestPermission();
		if (perm !== "granted") return "denied";
		return (await subscribeAndSave(await getRegistration())) ? "granted" : "error";
	} catch {
		return "error";
	}
}

/** Fire a server-side test push to confirm the round-trip works. */
export async function sendTestPush(): Promise<void> {
	await api("/v1/push/test", { method: "POST" }).catch(() => undefined);
}
