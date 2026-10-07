/**
 * The chat history a turn replays, and whether it is all of it (#898).
 *
 * The model was handed the last ten messages as though they were the whole conversation, so a fact
 * stated before them read as one never stated. The caller reads ONE past the window; when that one
 * exists, the window is led by a note saying older messages are not shown.
 */
export const OLDER_HISTORY_NOTE =
	"[platform: earlier messages in this conversation are not shown here — only the last ten. Do not treat something absent from them as never said; what was kept from older turns is in memory.]";

export function historyWindow<T>(newestPlusOne: readonly T[], max: number, note: (text: string) => T): T[] {
	return newestPlusOne.length > max ? [note(OLDER_HISTORY_NOTE), ...newestPlusOne.slice(-max)] : [...newestPlusOne];
}
