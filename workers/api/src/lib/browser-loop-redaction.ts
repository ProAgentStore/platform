import type { BrowserAction } from "./browser-action.js";
import { resolveSnapshotElement } from "./commit-guard.js";
import { collectJobSecrets, isSecretFieldName, makeSecretRedactor } from "./redact-secrets.js";

/** Run-scoped, shared across handoff rounds. Screenshot visibility never changes log redaction. */
export function createBrowserRunRedactor(job: unknown) {
	const secrets = new Set(collectJobSecrets(job));
	let current = makeSecretRedactor([...secrets]);
	return {
		redact: (text: string) => current(text),
		rememberJob(updatedJob: unknown) {
			for (const secret of collectJobSecrets(updatedJob)) secrets.add(secret);
			current = makeSecretRedactor([...secrets]);
		},
		rememberAction(action: BrowserAction | undefined, snapshot: string) {
			if (!action?.text || !["type", "select"].includes(action.action)) return;
			const target = resolveSnapshotElement(snapshot, action.ref);
			if (!isSecretFieldName(action.name, action.role) && !isSecretFieldName(target?.name, target?.role)) return;
			secrets.add(action.text);
			current = makeSecretRedactor([...secrets]);
		},
	};
}

export type BrowserRunRedactor = ReturnType<typeof createBrowserRunRedactor>;
