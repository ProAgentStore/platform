import { useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import type { PendingOwnerInputsResponse } from "../lib/types";

export type PendingSecureInput = PendingOwnerInputsResponse["instances"][number];

/** Index the account-wide answer by instance id. */
export function indexPendingInputs(res: PendingOwnerInputsResponse | null | undefined): Map<string, PendingSecureInput> {
	return new Map((res?.instances ?? []).map((r) => [r.instanceId, r]));
}

/**
 * Which instances have a secure-input request waiting on the owner (#934) — one call for the whole
 * account, so the instance cards can say so without a request per card. Polled while the list is on
 * screen and the tab is visible; a failed poll keeps the last answer rather than clearing it.
 */
export function usePendingSecureInputs(enabled: boolean, pollMs = 30_000): Map<string, PendingSecureInput> {
	const [byInstance, setByInstance] = useState<Map<string, PendingSecureInput>>(new Map());
	useEffect(() => {
		if (!enabled) return;
		const load = () => {
			if (document.hidden) return;
			api<PendingOwnerInputsResponse>("/v1/instances/my/secure-inputs")
				.then((res) => setByInstance(indexPendingInputs(res)))
				.catch(() => undefined);
		};
		load();
		const t = setInterval(load, pollMs);
		return () => clearInterval(t);
	}, [enabled, pollMs]);
	return byInstance;
}
