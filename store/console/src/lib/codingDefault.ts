// The account's default coding engine: what a choice SENDS and what the page may claim afterwards (#1282).
//
// "Platform default" is the absence of an override, and the preferences route has one supported way to say that: `defaultEngineId: null`
// (or ""). The page used to send `coding: {}` instead, which the route rejects — `defaultEngineId` must be present — and it had already
// changed the control before asking, so a refused reset left the dropdown on "Platform default" while the account still stored Codex.
//
// So the choice is not applied to the page until the server has confirmed it: `saveCodingEngine` returns what the SERVER now stores, and
// the page shows that. A refusal returns no new value at all, so the control falls back to what was persisted.

export interface CodingWriteResponse {
	preferences?: { coding?: { defaultEngineId?: string } };
}

/** The body for a choice; "" is Platform default, which clears the override with an explicit `null`. */
export function codingWriteBody(choice: string): { coding: { defaultEngineId: string | null } } {
	return { coding: { defaultEngineId: choice || null } };
}

export type CodingSaveResult = { ok: true; persisted: string } | { ok: false; error: string };

/** Write the choice; resolve to the stored engine id ("" = Platform default) or to why it was refused. Never throws. */
export async function saveCodingEngine(write: (body: ReturnType<typeof codingWriteBody>) => Promise<CodingWriteResponse>, choice: string): Promise<CodingSaveResult> {
	try {
		const d = await write(codingWriteBody(choice));
		return { ok: true, persisted: d.preferences?.coding?.defaultEngineId ?? "" };
	} catch (e) {
		return { ok: false, error: e instanceof Error && e.message ? e.message : "Couldn't save that. Try again." };
	}
}
