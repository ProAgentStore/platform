/** Per-agent D1 database client. */
export interface DbClient {
	query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
	execute(
		sql: string,
		params?: unknown[],
	): Promise<{ changes: number; lastRowId: number }>;
	batch(statements: { sql: string; params?: unknown[] }[]): Promise<unknown[]>;
}
