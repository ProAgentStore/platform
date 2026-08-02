/**
 * Activity log — append-only events with amortized pruning.
 */
import type { ActivityEvent } from "../agent-storage-types.js";
import { type AgentStorageBaseCtor, MAX_EVENTS } from "./base.js";

export function withActivity<TBase extends AgentStorageBaseCtor>(Base: TBase) {
	return class extends Base {
		// ── Activity Log ──────────────────────────────────────────────────────────

		/**
		 * Append an activity event.
		 * Pruning is amortized: only runs every ~50 events (probabilistic).
		 */
		async logEvent(
			type: ActivityEvent["type"],
			userId?: string,
			data?: Record<string, unknown>,
			channel?: string,
		): Promise<ActivityEvent> {
			const event: ActivityEvent = {
				id: crypto.randomUUID(),
				type,
				agentId: this.agentId,
				userId,
				channel,
				data,
				createdAt: new Date().toISOString(),
			};
			await this.doStorage.put(`evt:${event.createdAt}:${event.id}`, event);

			// Amortized pruning: ~2% chance per write (roughly every 50 events)
			if (Math.random() < 0.02) {
				const all = await this.doStorage.list({ prefix: "evt:" });
				if (all.size > MAX_EVENTS) {
					const keys = [...all.keys()];
					const toDelete = keys.slice(0, keys.length - MAX_EVENTS);
					for (let i = 0; i < toDelete.length; i += 128) {
						await this.doStorage.delete(toDelete.slice(i, i + 128));
					}
				}
			}

			return event;
		}

		/**
		 * Get recent activity events.
		 */
		async getEvents(opts?: {
			limit?: number;
			type?: ActivityEvent["type"];
			userId?: string;
		}): Promise<ActivityEvent[]> {
			const limit = opts?.limit || 50;
			const all = await this.doStorage.list<ActivityEvent>({
				prefix: "evt:",
				reverse: true,
				limit: limit * 2, // Over-fetch for filtering
			});
			let events = [...all.values()];

			if (opts?.type) events = events.filter((e) => e.type === opts.type);
			if (opts?.userId) events = events.filter((e) => e.userId === opts.userId);

			return events.slice(0, limit);
		}
	};
}
