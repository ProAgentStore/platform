// The account's notification settings as ONE value with ONE writer (#1283).
//
// `notifications` is a single section of the account preferences, and the API replaces a section as a whole:
// a write that names `{muted}` and not `rules` DELETES the rules (that is the contract, and the other callers —
// the MCP tools among them — rely on it). The Preferences page used to have three controls over that one section:
// the type switches, the Which agents scope, and the rules editor. Each kept its own copy of the section, each
// wrote its own half, and each half-write silently undid the others — a switch erased the rules, a rule save
// restored the mutes the page had loaded minutes before — while the page went on displaying settings the server
// no longer held.
//
// The fix is not a different write contract; it is that there is only ever ONE copy and ONE writer:
//
//   • every control edits THIS state, and every write sends the WHOLE section built from it, so a write can only
//     ever be "what the page shows";
//   • writes go out one at a time, in order, each built from the latest state when it is sent;
//   • what the page shows is this state, never a control's private copy — so a failed write rolls the page back to
//     what the server last confirmed, and nothing unsaved looks applied;
//   • a response that arrives after a newer edit is ignored, so a late read can never put an old value back.
//
// Pure TypeScript with an injected transport, so the order-of-edits, reload, race and failure behaviour is tested
// without a browser, and against the real route in workers/api.
import type { AccountPreferencesResponse, InstanceNotificationPolicy, NotificationPolicyRule } from "./types";

export type EffectiveMatrix = InstanceNotificationPolicy["effective"];

export interface NotificationsState {
	/** Notification types silenced for push. */
	muted: string[];
	/** The agents whose updates may interrupt; EMPTY means every agent (the stored shape has no key for "all"). */
	instances: string[];
	/** The owner's rules, as stored. */
	rules: NotificationPolicyRule[];
	/** The server's resolved answer for each row — read back, never computed here. */
	effective: EffectiveMatrix;
}

export const EMPTY_NOTIFICATIONS: NotificationsState = { muted: [], instances: [], rules: [], effective: [] };

/** What the section looks like on the wire: `instances` and `rules` are ABSENT when empty — absence is "all" / "none", and a stored `[]` would read as a choice. */
export interface NotificationsSection {
	muted: string[];
	instances?: string[];
	rules?: NotificationPolicyRule[];
}

export function stateFromResponse(d: AccountPreferencesResponse): NotificationsState {
	const n = d.preferences?.notifications;
	return { muted: [...(n?.muted ?? [])], instances: [...(n?.instances ?? [])], rules: [...(n?.rules ?? [])], effective: d.notificationEffective ?? [] };
}

/** The WHOLE section for a write: every control's current value, so no write can undo another control. */
export function sectionFrom(state: NotificationsState): NotificationsSection {
	return { muted: [...state.muted], ...(state.instances.length ? { instances: [...state.instances] } : {}), ...(state.rules.length ? { rules: [...state.rules] } : {}) };
}

/**
 * An edit says what the owner CHANGED, not what the whole field should now be: two changes made before the page re-renders must
 * both land, and a field computed from a render's stale props would let the second undo the first.
 */
export type NotificationsEdit =
	| { kind: "muted"; muted: string[] }
	| { kind: "instances"; instances: string[] }
	| { kind: "rules"; rules: NotificationPolicyRule[] }
	/** One notification type switched on (`notify`) or off. */
	| { kind: "toggleType"; id: string; notify: boolean }
	/** One agent switched on or off, over the agents `roster` lists. Ticking all of them clears the scope; the last one cannot be switched off. */
	| { kind: "toggleInstance"; id: string; notify: boolean; roster: string[] };

/** The scope as stored after one agent is toggled: `[]` = every agent. Null = refused (it would leave no agent on, which reads back as "all"). */
export function toggledScope(scope: readonly string[], id: string, notify: boolean, roster: readonly string[]): string[] | null {
	const current = scope.length ? scope.filter((s) => roster.includes(s)) : [...roster];
	const next = notify ? [...new Set([...current, id])] : current.filter((s) => s !== id);
	if (next.length === 0) return null;
	return next.length >= roster.length ? [] : next;
}

/** Change ONE field; the others are carried from `state`, which is the whole point. */
export function applyEdit(state: NotificationsState, edit: NotificationsEdit): NotificationsState {
	switch (edit.kind) {
		case "muted":
			return { ...state, muted: [...new Set(edit.muted)] };
		case "instances":
			return { ...state, instances: [...new Set(edit.instances)] };
		case "rules":
			return { ...state, rules: [...edit.rules] };
		case "toggleType":
			return { ...state, muted: edit.notify ? state.muted.filter((m) => m !== edit.id) : [...new Set([...state.muted, edit.id])] };
		case "toggleInstance": {
			const next = toggledScope(state.instances, edit.id, edit.notify, edit.roster);
			return next === null ? state : { ...state, instances: next };
		}
	}
}

export interface NotificationsTransport {
	/** The authoritative stored state (and the resolved matrix). */
	read(): Promise<NotificationsState>;
	/** Write the whole section. Rejects if the server refuses. */
	write(section: NotificationsSection): Promise<void>;
}

export interface NotificationsSnapshot {
	state: NotificationsState;
	/** The first read has landed. Until it has, the page does not know what is stored — and must not write, or it would overwrite it with defaults. */
	loaded: boolean;
	/** At least one write is queued or in flight. */
	saving: boolean;
	/** Why the last load or write failed, or "". Cleared by the next edit. */
	error: string;
}

const messageOf = (e: unknown): string => (e instanceof Error && e.message ? e.message : "Couldn't save that. Try again.");

export class NotificationsController {
	private visible: NotificationsState = EMPTY_NOTIFICATIONS;
	/** The last state the server is known to hold. A failed write returns the page to this. */
	private confirmed: NotificationsState = EMPTY_NOTIFICATIONS;
	private loaded = false;
	private error = "";
	private pending = 0;
	/** Counts edits. A response that started before the latest edit is stale. */
	private editSeq = 0;
	/** Bumped when a write fails: edits queued behind it were built on a state that never existed, so they are dropped. */
	private generation = 0;
	private chain: Promise<unknown> = Promise.resolve();
	private snapshot: NotificationsSnapshot;
	private listeners = new Set<() => void>();

	constructor(private readonly transport: NotificationsTransport) {
		this.snapshot = this.build();
	}

	private build(): NotificationsSnapshot {
		return { state: this.visible, loaded: this.loaded, saving: this.pending > 0, error: this.error };
	}

	private publish(): void {
		this.snapshot = this.build();
		for (const l of this.listeners) l();
	}

	/** Stable between changes, as `useSyncExternalStore` requires. */
	getSnapshot = (): NotificationsSnapshot => this.snapshot;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	/** Read the stored state. Ignored if the owner has edited since it was asked for — an older answer must not replace a newer choice. */
	async load(): Promise<void> {
		const started = this.editSeq;
		try {
			const fresh = await this.transport.read();
			if (started !== this.editSeq) return;
			this.visible = this.confirmed = fresh;
			this.loaded = true;
			this.error = "";
		} catch (e) {
			if (started !== this.editSeq) return;
			this.error = messageOf(e);
		}
		this.publish();
	}

	/**
	 * Apply one edit to the CURRENT state and write the whole section. Resolves to whether the server confirmed it. The page shows the edit at
	 * once; a refusal returns it to what the server last confirmed, with the reason in `error`.
	 */
	edit(edit: NotificationsEdit): Promise<boolean> {
		if (!this.loaded) {
			this.error = "Your notification settings haven't loaded yet, so nothing was changed.";
			this.publish();
			return Promise.resolve(false);
		}
		this.editSeq++;
		const generation = this.generation;
		this.error = "";
		this.visible = applyEdit(this.visible, edit);
		this.pending++;
		this.publish();
		const result = this.chain.then(() => this.flush(generation));
		this.chain = result.catch(() => undefined);
		return result;
	}

	private async flush(generation: number): Promise<boolean> {
		if (generation !== this.generation) {
			this.pending--;
			this.publish();
			return false;
		}
		// Built NOW, from the latest state: edits made while an earlier write was in flight ride along, in order.
		const sent = this.visible;
		const sentAt = this.editSeq;
		// An earlier write in this queue already carried this edit (it was built from the latest state), or the edits cancelled out:
		// the server already holds exactly this, so there is nothing to send.
		if (JSON.stringify(sectionFrom(sent)) === JSON.stringify(sectionFrom(this.confirmed))) {
			this.pending--;
			this.publish();
			return true;
		}
		try {
			await this.transport.write(sectionFrom(sent));
			this.confirmed = sent;
		} catch (e) {
			this.generation++;
			this.error = messageOf(e);
			this.visible = this.confirmed;
			this.pending--;
			this.publish();
			await this.refresh();
			return false;
		}
		this.pending--;
		this.publish();
		// Read back the server's answer (the resolved matrix) — but only if nothing newer has been chosen since.
		if (this.pending === 0 && sentAt === this.editSeq) await this.refresh();
		return true;
	}

	/** Re-read after a write or a refusal; ignored if the owner has edited since it was asked for. */
	private async refresh(): Promise<void> {
		const started = this.editSeq;
		try {
			const fresh = await this.transport.read();
			if (started !== this.editSeq || this.pending > 0) return;
			this.visible = this.confirmed = fresh;
			this.publish();
		} catch {
			/* the write's outcome stands; only the resolved matrix is stale until the next read */
		}
	}
}
