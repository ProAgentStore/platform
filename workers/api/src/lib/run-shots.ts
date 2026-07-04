/** R2 key for a per-step run screenshot — one JPEG blob per browser action, so a
 *  whole automation run can be replayed visually. Shared by the workflow that
 *  writes them and the route that serves them. */
export const runShotKey = (userId: string, instanceId: string, taskId: string, seq: number): string =>
	`runshot/${userId}/${instanceId}/${taskId}/${String(seq).padStart(5, "0")}.jpg`;
