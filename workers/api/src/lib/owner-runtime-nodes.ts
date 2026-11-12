/** Owner-wide registration metadata. Never cache settled identity evidence: a runner RPC or
 * registration write can change it before the next lookup (including within one request).
 * Concurrent readers in this isolate share one D1 call; failures remain failures and are retried.
 * Database identity and owner both scope the flight. No credentials or resource blobs are read.
 */
export interface OwnerRuntimeNode {
	instance_id: string;
	runner_node: string;
	machine_id: string | null;
	runner_version: string | null;
	last_seen_at: string | null;
	updated_at: string;
}

const flights = new WeakMap<D1Database, Map<string, Promise<OwnerRuntimeNode[]>>>();

export async function ownerRuntimeNodes(env: { DB: D1Database }, userId: string): Promise<OwnerRuntimeNode[]> {
	let owners = flights.get(env.DB);
	if (!owners) {
		owners = new Map();
		flights.set(env.DB, owners);
	}
	let flight = owners.get(userId);
	if (!flight) {
		flight = env.DB.prepare(
			"SELECT instance_id, runner_node, machine_id, runner_version, last_seen_at, updated_at FROM instance_runtime_nodes WHERE user_id = ?1 ORDER BY updated_at DESC",
		).bind(userId).all<OwnerRuntimeNode>().then((r) => r.results ?? []);
		owners.set(userId, flight);
		const clear = () => { if (owners.get(userId) === flight) owners.delete(userId); };
		void flight.then(clear, clear);
	}
	return (await flight).map((r) => ({ ...r }));
}
