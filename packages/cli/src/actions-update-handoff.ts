/** The Actions service changes CLI releases only after `pags up` proves the payload. */
import { approvedActionsPayload, olderThan, payloadRoot, pinActionsPayload, unpinActionsPayload } from "./bootstrap/payload.js";

export { pinActionsPayload, unpinActionsPayload };

export function approvedCliUpdateAvailable(currentVersion: string, root: string = payloadRoot()): string | null {
	const approved = approvedActionsPayload(root, null)?.version;
	return approved && olderThan(currentVersion, approved) ? approved : null;
}
