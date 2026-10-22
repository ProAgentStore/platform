import { useEffect, useMemo, useSyncExternalStore } from "react";
import { api } from "@proagentstore/sdk/client";
import { NotificationsController, type NotificationsTransport, stateFromResponse } from "./notificationsStore";
import type { AccountPreferencesResponse } from "./types";

/** The real transport: the preferences route, whose `notifications` section is replaced whole on every write. */
export const accountNotificationsTransport: NotificationsTransport = {
	read: async () => stateFromResponse(await api<AccountPreferencesResponse>("/v1/preferences")),
	write: async (section) => {
		await api("/v1/preferences", { method: "PUT", body: JSON.stringify({ notifications: section }) });
	},
};

/** One controller per page: every notification control reads and edits this, so none can hold a stale copy of another's value (#1283). */
export function useNotificationsStore(transport: NotificationsTransport = accountNotificationsTransport) {
	const controller = useMemo(() => new NotificationsController(transport), [transport]);
	useEffect(() => {
		void controller.load();
	}, [controller]);
	const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
	return { snapshot, controller, reload: () => controller.load() };
}
