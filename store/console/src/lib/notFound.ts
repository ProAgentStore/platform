/**
 * Did a load fail because the thing is GONE (#894)? Only a 404 — read off the SDK's `ApiError.status`
 * — means the subject was deleted; any other failure (offline, 500, 401) must not tell the reader
 * that their agent no longer exists.
 */
export function isNotFoundError(e: unknown): boolean {
	return (e as { status?: unknown } | null)?.status === 404;
}
