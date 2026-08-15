/**
 * Which `reportClientError` SOURCE a voice call site reports under — the client half of #571.
 *
 * ## What was wrong
 *
 * `reportClientError` takes no level (deliberately — see `routes/errors.ts`), and the server derived
 * one from the HTTP status alone. The voice stack reports with NO status, so every observation it
 * made landed on the `error` branch. Measured in production 2026-08-15: 19 of the 40 newest rows
 * were `client:voice`, all at `error`, and eight of them (25 occurrences after repeat-collapse) were
 * the noise gate correctly discarding Whisper's "Thank you for watching." hallucination off a silent
 * microphone. `?level=error` — the documented "bugs only" filter — returned mostly discarded frames.
 *
 * ## Why a blanket rule on `voice` was rejected
 *
 * `client:voice` is NOT a homogeneous source, and that single fact decides the design. It carries
 * designed discards AND genuine failures on the same string:
 *
 *   - designed: the end-of-turn gate (`planTurnClose`), the noise gate (`planNoiseRejection`) on four
 *     paths, the send gate (`planSend`), the clip gate (`planClipGate`), the echo-tail ignore
 *     (`classifyResult`);
 *   - genuine: the audio monitor failing to construct, a Whisper 400/401 or timeout, the transcription
 *     watchdog, hands-free bailing out because the recognizer died four times in a row.
 *
 * Downgrading the source wholesale would have hidden the second list — the mirror of the bug being
 * fixed — so the SOURCE splits instead. A designed decision reports under {@link VOICE_DECISION}; a
 * failure keeps {@link VOICE_FAILURE}. The server maps `client:voice-decision` to `warn`
 * (`OBSERVATION_SOURCES` in `workers/api/src/lib/error-log.ts`), which is what `warn` has meant since
 * #424: recorded, not counted as a bug.
 *
 * ## The line between them
 *
 * A site reports a DECISION when the voice stack did what it is built to do and no component failed —
 * whatever the cost to the turn. A discarded turn is still a decision: the row exists because #377,
 * #490, #510, #511 and #535 were all diagnosed from exactly these rows, and it must keep existing with
 * its full context. Nothing is reduced here; only the severity it claims changes.
 *
 * A site reports a FAILURE when something the stack depends on did not work — a constructor threw, a
 * provider answered badly, a deadline passed, a recognizer died. The test that pins this split over
 * the whole voice tree is `report-sources.test.ts`; a new call site cannot land unclassified.
 *
 * Both are constants rather than inline strings so the classification is a fact about the code and not
 * a fact about a test's memory of it.
 */

/**
 * A designed outcome the voice stack decided on — a gate discarding a turn, a clip judged without
 * measurement, a result ignored as the agent's own echo. Recorded, never counted as a bug.
 *
 * Stored as `client:voice-decision`, which is what `list_errors(source: …)` filters on. Note for
 * anyone re-running #511/#535/#538's queries: those rows used to be `client:voice` and are now split
 * across the two names, so an investigation of the gates reads THIS one.
 */
export const VOICE_DECISION = "voice-decision";

/**
 * Something the voice stack depends on failed. Stored as `client:voice` — unchanged, so every
 * existing query for real voice failures keeps working and keeps returning `level: "error"`.
 */
export const VOICE_FAILURE = "voice";
