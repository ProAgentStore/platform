/**
 * Pure hands-free-conversation control logic, split out of the React hook so the
 * delicate "when the recognizer ends, should we reopen the mic or bail?" decision is
 * unit-tested without a browser.
 */

import { normalizeSpeech, trimTrailingPunctuation } from "./normalize.js";

/** Tunables for the restart/freeze guard. */
export interface RestartConfig {
	/** A recognizer end sooner than this after start counts as a "rapid" (failing) end. */
	rapidMs?: number;
	/** After this many consecutive rapid ends, bail out of conversation mode (a mic-blocked
	 *  / instant-abort loop would otherwise peg the CPU and freeze the page). */
	maxRapid?: number;
}

export interface RestartDecision {
	/** Give up on conversation mode — the recognizer keeps dying instantly. */
	bail: boolean;
	/** The updated consecutive-rapid-end counter to carry forward. */
	nextRapidEnds: number;
	/** How many consecutive rapid ends this decision COUNTED, including the one it just judged.
	 *  Carried out separately because `nextRapidEnds` is reset to 0 on a bail, so it cannot say
	 *  how the bail was reached — and a bail that cannot say that is the #387 defect in miniature. */
	rapidEnds: number;
}

/**
 * Decide what to do when the recognizer ends mid-conversation. If it ended almost
 * immediately after starting we're likely in a failing restart loop — count it, and
 * after `maxRapid` consecutive rapid ends, bail. A healthy (long-enough) turn resets
 * the counter and we reopen the mic.
 *
 * @param elapsedMs  time since the last listen START
 * @param rapidEnds  the current consecutive-rapid-end count
 */
export function decideRestart(elapsedMs: number, rapidEnds: number, cfg: RestartConfig = {}): RestartDecision {
	const rapidMs = cfg.rapidMs ?? 800;
	const maxRapid = cfg.maxRapid ?? 4;
	if (elapsedMs < rapidMs) {
		const next = rapidEnds + 1;
		return next >= maxRapid ? { bail: true, nextRapidEnds: 0, rapidEnds: next } : { bail: false, nextRapidEnds: next, rapidEnds: next };
	}
	return { bail: false, nextRapidEnds: 0, rapidEnds: 0 };
}

/**
 * What a hands-free BAIL says and records (#387).
 *
 * Bailing out is correct — the alternative is a restart loop that pegs the CPU and freezes the
 * page — but it used to be the one path in the whole voice stack that did it in silence. No
 * notice, no durable row, no console line: hands-free simply stopped and the mode toggle flipped
 * back on its own, which from the outside is indistinguishable from a crash. Twenty lines away in
 * the same handler, an error the recognizer REPORTS is logged, surfaced and self-clearing; the
 * failure it expresses by dying four times in a row — the more serious of the two, because it ends
 * the whole session rather than one turn — said nothing at all.
 *
 * Both halves are here because they answer different questions and neither substitutes for the
 * other. The NOTICE is the only thing that helps the user: every cause on the list (permission
 * revoked mid-session, another tab or app took the microphone, the OS suspended it) is
 * user-fixable, and only if it is named. The REPORT is the only thing that makes "hands-free keeps
 * dropping out on my phone" countable — with no row in the durable log there is nothing to confirm
 * it against, which is the same shape as #241 and #376: the system knew and no surface read it back.
 *
 * Shaped like `planNoiseRejection` in turn.ts: a FIXED report string, because `reportClientError`
 * de-dups on source+message and a burst must collapse to one row, with everything that varies in
 * the context.
 */
export interface RestartBailPlan {
	/** Shown to the user, and deliberately NOT auto-cleared like a transcription error: the
	 *  session is gone until they act, so a message that expires restores the original silence. */
	notice: string;
	/** Durable-log message (`client:voice`). Fixed — see above. */
	report: string;
	/** What varies per bail, so the frequency is measurable per device / STT mode. */
	context: { rapidEnds: number; sttWhisper: boolean };
}

const BAIL_NOTICE =
	"⚠ Hands-free stopped — the microphone stopped responding. Check that mic access is still allowed, close any other tab or app using it, then turn hands-free back on.";
const BAIL_REPORT = "hands-free bailed out — the recognizer ended immediately several times in a row";

export function planRestartBail(s: { rapidEnds: number; sttWhisper: boolean }): RestartBailPlan {
	return { notice: BAIL_NOTICE, report: BAIL_REPORT, context: { rapidEnds: s.rapidEnds, sttWhisper: s.sttWhisper } };
}

/**
 * The active interaction mode, derived from the two primitives so there is ONE source
 * of truth (no contradictory Talk+Speak+Hands-free combos): continuous conversation ⇒
 * `"handsfree"`; replies-aloud without continuous listen ⇒ `"ptt"` (push-to-talk);
 * neither ⇒ `"text"`.
 */
export type VoiceMode = "text" | "ptt" | "handsfree";
export function resolveVoiceMode(convoOn: boolean, speakOn: boolean): VoiceMode {
	if (convoOn) return "handsfree";
	if (speakOn) return "ptt";
	return "text";
}

/** Presentational state for the single "voice status" pill in the chat UI. */
export interface VoiceStatus {
	label: string;
	/** `work` = transcribing/generating (accent, spinner); `live` = mic hot (green);
	 *  `speak` = agent talking back (accent); `idle` = waiting for the user (neutral). */
	tone: "work" | "live" | "idle" | "speak";
	/** Show a spinner (vs a mic glyph). */
	spin: boolean;
	/** Tappable — toggles a manual talk turn (Tap-to-talk). */
	tap: boolean;
	/** Which glyph the pill shows, so both call sites render consistently. */
	icon: "mic" | "spin" | "speak";
}

/**
 * Resolve the single, always-visible voice-status pill so the user ALWAYS knows what's
 * happening — Listening → Transcribing → Working → Speaking — instead of silence until
 * the reply lands. Pure so this branchy presentation logic is tested. `null` means show
 * nothing (idle text chat). `thinking` (agent generating) wins in every mode, then
 * `speaking` (agent talking aloud) — both show even in text chat (e.g. a manual replay).
 */
export function resolveVoiceStatus(input: {
	mode: VoiceMode;
	thinking: boolean;
	transcribing: boolean;
	talking: boolean;
	listening: boolean;
	/** The agent is talking aloud (TTS). Shown in every mode so the mic clearly isn't hot. */
	speaking?: boolean;
	/** Hands-free mic paused via Mute — the pill must not claim it's listening. */
	muted?: boolean;
	/** A voice session is opening the mic (#284) — see derivePhase. */
	starting?: boolean;
}): VoiceStatus | null {
	const { mode, thinking, transcribing, talking, listening, speaking, muted, starting } = input;
	if (thinking) return { label: "Working on it…", tone: "work", spin: true, tap: false, icon: "spin" };
	// Agent talking back — surface in EVERY mode (incl. a manual replay in text chat) so
	// it's obvious the mic is not listening to you right now (the self-transcription worry).
	// Tappable so the user can cut the reply off (the pill's onClick routes a `speak`-tone tap
	// to cancelSpeak, not toggleTalk).
	if (speaking) return { label: "Speaking · tap to stop", tone: "speak", spin: false, tap: true, icon: "speak" };
	// Above the text-mode return for the same reason derivePhase puts it there: the mode has not
	// flipped yet while the mic is opening, so a check below this line would never be reached.
	if (starting) return { label: "Starting…", tone: "work", spin: true, tap: false, icon: "spin" };
	if (mode === "text") return null;
	if (transcribing) return { label: "Transcribing…", tone: "work", spin: true, tap: false, icon: "spin" };
	if (talking) return { label: "Listening — tap to send", tone: "live", spin: false, tap: true, icon: "mic" };
	if (mode === "ptt") return { label: "Tap to talk", tone: "idle", spin: false, tap: true, icon: "mic" };
	// hands-free
	if (muted) return { label: "Muted", tone: "idle", spin: false, tap: false, icon: "mic" };
	return listening
		? { label: "Listening…", tone: "live", spin: false, tap: false, icon: "mic" }
		: { label: "Hands-free — just talk", tone: "idle", spin: false, tap: false, icon: "mic" };
}

/** A spoken command the hook acts on locally instead of sending as a chat message. */
export type VoiceCommand = "repeat" | "mute" | "unmute" | "exit" | "next" | "back" | "scrap";

/** Per-instance overrides for the command keywords (Settings → Voice). Empty/absent =
 *  use the built-in defaults for repeat/mute/unmute/exit/next; stop-words are OFF unless configured.
 *  A phrase set on ANY of these fields outranks every built-in — see {@link commandPhrases}. */
export interface VoiceCommandWords {
	/** Phrases that re-speak the last reply. Overrides the built-in multilingual set. */
	repeat?: string[];
	/** Phrases that mute the mic. */
	mute?: string[];
	/** Phrases that re-open the mic while muted (#152). */
	unmute?: string[];
	/** Phrases that leave voice entirely and return to text mode (#165). */
	exit?: string[];
	/** Phrases that move you to the next agent asking for you (#277). */
	next?: string[];
	/** Phrases that return you to the agent you were with before this one (#279). Whole-utterance
	 *  AND final-only — see BACK_BY_LANG. */
	back?: string[];
	/** Phrases that scrap the last turn (#342). Whole-utterance ONLY — see SCRAP_BY_LANG. */
	scrap?: string[];
	/**
	 * The stop-speech keyword (#153) — halt the agent's playback. Not a command LIST and never
	 * returned by {@link matchVoiceCommand} (it has its own gated matcher, {@link matchesStopSpeech}),
	 * but it is an explicit user BINDING, so the precedence rule in {@link commandPhrases} has to be
	 * able to see it. Without it, a keyword of `"stop stop"` was outranked by the built-in EXIT list
	 * that happens to contain the same phrase (#385).
	 */
	stopSpeech?: string;
}

/** "Unmute" phrasings per language. The mirror of MUTE_BY_LANG — matched ONLY while muted
 *  (see matchVoiceCommand), so these words are inert during a normal turn and can't hijack
 *  ordinary speech. */
const UNMUTE_BY_LANG: Record<string, string[]> = {
	en: ["unmute", "unmute mic", "unmute the mic", "unmute microphone", "start listening", "resume listening", "listen up", "wake up"],
	es: ["reactivar", "activar micrófono", "escucha", "vuelve a escuchar"],
	fr: ["réactive le micro", "reprends l'écoute", "écoute moi"],
	de: ["stummschaltung aufheben", "hör wieder zu", "wach auf"],
	it: ["riattiva", "riattiva il microfono", "ascolta"],
	pt: ["reativar", "reativar microfone", "volte a ouvir"],
	zh: ["取消静音", "开麦", "开始听"],
	ja: ["ミュート解除", "聞いて"],
	ko: ["음소거 해제", "들어봐"],
	hi: ["अनम्यूट", "फिर से सुनो"],
};

/**
 * "Exit voice" phrasings per language (#165) — leave voice mode entirely and go back to
 * typing. Distinct from mute: mute keeps the session live and listening for control words,
 * exit tears the whole thing down.
 *
 * ── The bare stop word (#331)
 *
 * Every English phrase here used to require "voice" AFTER the verb, so bare `"stop"` matched
 * nothing and was sent to the agent as a chat message. The agent — which has no view of, and no
 * control over, client-side voice state — answered conversationally: *"Got it. Stopped."* That
 * is the worst available outcome, because the reply CONFIRMS an action nobody performed, and the
 * user disengaged with the microphone still open.
 *
 * A bare word is safe here by construction, not by luck: `phraseMatchesTranscript` requires a
 * single-word phrase to BE the whole utterance. That rule was added when "next agent" fired
 * inside "the next agent in the chain is the builder" — and it is exactly what keeps "don't stop
 * now" a message while "Stop." is a command. The utterance in the report WAS the whole utterance.
 *
 * `"stop stop"` is listed too, and it is not redundant: the doubled emphatic is what the owner
 * says, and Whisper renders it `"Stop-stop."` → two normalised words, which the single-word rule
 * can never match. As a multi-word phrase it can also match inside a longer utterance; a repeated
 * imperative is distinctive enough for that to be safe, in the way "next agent" was not.
 *
 * NOT moved here: `"stop listening"`, which stays a MUTE phrase. It says literally what mute
 * does, exit is checked first and would have stolen it, and silencing the mic is the smaller,
 * recoverable reading of an ambiguous request.
 *
 * What #331 did not anticipate is a user binding one of these words to a DIFFERENT action. It
 * happened with the stop-speech keyword, and the built-in silently won (#385) — so this list is
 * now filtered by {@link commandPhrases} against every phrase the user bound elsewhere.
 */
const EXIT_BY_LANG: Record<string, string[]> = {
	en: ["exit voice", "exit voice mode", "stop voice", "stop voice mode", "leave voice", "text mode", "switch to text", "back to text", "stop", "stop stop"],
	es: ["salir de voz", "modo texto", "cambiar a texto", "para", "basta"],
	fr: ["quitter la voix", "mode texte", "passer au texte", "stop", "arrête"],
	de: ["sprachmodus beenden", "textmodus", "zurück zum text", "stopp", "aufhören"],
	it: ["esci dalla voce", "modalità testo", "stop", "basta"],
	pt: ["sair da voz", "modo texto", "pare", "chega"],
	zh: ["退出语音", "文字模式", "切换到文字", "停", "停止"],
	ja: ["音声モード終了", "テキストモード", "ストップ", "やめて"],
	ko: ["음성 모드 종료", "텍스트 모드", "그만", "중지"],
	hi: ["वॉइस बंद करो", "टेक्स्ट मोड", "रुको"],
};

/**
 * "Next agent" phrasings per language (#277) — move to the agent that is asking for you.
 *
 * Deliberately SHORT lists, and NOUN PHRASES ARE EXCLUDED. `phraseMatchesTranscript` lets a
 * multi-word phrase match as a whole-word run anywhere in an utterance, so "next agent" would
 * fire on "the next agent in the chain is the builder" — a sentence a coordinator agent's user
 * says constantly, and one where being teleported away mid-thought is the worst possible
 * outcome. Only IMPERATIVE forms ("switch agent") survive: those read as an instruction to the
 * app wherever they appear.
 *
 * The bare word is safe by construction — a single-word phrase must BE the whole utterance —
 * which is what keeps "what's next for this repo?" a message, exactly as the ticket requires.
 * German's bare word is "nächster" and not "weiter", which means "carry on" and is something a
 * user genuinely says TO an agent.
 */
const NEXT_BY_LANG: Record<string, string[]> = {
	en: ["next", "switch agent", "switch agents", "who needs me"],
	es: ["siguiente", "cambiar de agente"],
	fr: ["suivant", "changer d'agent"],
	de: ["nächster", "agent wechseln"],
	it: ["prossimo", "cambia agente"],
	pt: ["próximo", "trocar de agente"],
	zh: ["下一个", "切换代理"],
	ja: ["次", "エージェント切り替え"],
	ko: ["다음", "에이전트 전환"],
	hi: ["अगला", "एजेंट बदलो"],
};

/**
 * "Go back" phrasings per language (#279) — return to the agent you were with before this one.
 *
 * This is the reversal of an agent-mediated TRANSFER, and shipping the transfer without it would
 * ship a one-way door: an agent hands you to another agent, and in hands-free the only way back is
 * the screen — which is the exact failure the whole feature exists to remove. It is deliberately
 * NOT `next`: `next` returns you to the previous agent only if that agent has an unread
 * notification, and being transferred AWAY from an agent does not notify you about it, so "next"
 * would either do nothing or take you somewhere third.
 *
 * ── Matched like `scrap`, not like `next`, and the reason is the partial
 *
 * Every phrase here is ordinary English in the middle of a sentence — "let's go back and fix the
 * parser", "can you take me back to the previous version". The two rules the rest of this file
 * uses both fire on those:
 *
 *   - the multi-word rule matches a whole-word run ANYWHERE, so "go back" fires inside the first;
 *   - the whole-utterance rule applied to a PARTIAL fires too, because the recognizer's guess at a
 *     sentence still being spoken is momentarily exactly "go back" on the way to the rest of it.
 *
 * So `back` takes `scrap`'s treatment (#342): whole-utterance AND judged on FINAL transcripts only
 * ({@link commandStateFor}). "Go back." moves you; "we should go back and fix that" is a message.
 * That costs a beat — the move lands when the recognizer closes the utterance rather than mid-word
 * — which is the right trade for a command that changes who is listening to you.
 *
 * No bare single word. "Back" alone is a plausible one-word answer to an agent's question, and
 * this list must not be reachable by a slip of the recogniser.
 */
const BACK_BY_LANG: Record<string, string[]> = {
	en: ["go back", "take me back", "switch back", "go back to the previous agent", "previous agent"],
	es: ["volver", "vuelve al agente anterior", "agente anterior"],
	fr: ["reviens en arrière", "agent précédent", "ramène moi"],
	de: ["zurück zum vorherigen agenten", "vorheriger agent", "bring mich zurück"],
	it: ["torna indietro", "agente precedente"],
	pt: ["voltar atrás", "agente anterior", "me leve de volta"],
	zh: ["回到上一个", "上一个代理", "带我回去"],
	ja: ["前のエージェントに戻って", "戻って"],
	ko: ["이전 에이전트로", "돌아가 줘"],
	hi: ["वापस ले चलो", "पिछला एजेंट"],
};

/**
 * "Scrap the last turn" phrasings per language (#342) — the FIRST destructive command in this
 * vocabulary, and matched by a stricter rule than any of them.
 *
 * ── Why the usual multi-word rule is wrong here
 *
 * `phraseMatchesTranscript` lets a MULTI-word phrase match as a whole-word run anywhere in an
 * utterance, on the reasoning that two words together are distinctive enough not to hijack normal
 * speech. That reasoning does not survive this word list. Both of these are ordinary sentences:
 *
 *     "don't scrap that, keep it"          → contains "scrap that"
 *     "scrap that idea and let's move on"  → contains "scrap that"
 *
 * The first is the user REFUSING the action and would perform it; the second is talking about a
 * plan and would delete the plan. Every other command in this file is recoverable — mute, unmute,
 * repeat, switch agent — so a false positive costs a moment's confusion. This one destroys a
 * message. So `matchVoiceCommand` matches scrap with `{ whole: true }`: the ENTIRE utterance must
 * be the phrase, the same precision the single-word rule already gives "mute" and "stop", applied
 * regardless of word count. "Scrap that." fires; the two sentences above stay messages, as does
 * "we should scrap that approach".
 *
 * ── What is deliberately NOT in the English list
 *
 * Bare "delete that". A subscriber talking to the Coder says exactly that about a file, and the
 * whole-utterance rule cannot tell the two apart — it is the one phrase here whose most likely
 * meaning is something else entirely. "delete that message" and "delete last message" say which
 * object they mean, so they stay. "ignore that" / "disregard that" stay too: as a complete
 * utterance they already mean "do not act on what I just said", which IS this command.
 *
 * Lists are short and every entry is multi-word by choice. A bare word would be legal under the
 * whole-utterance rule, but a one-syllable slip of the recogniser should not be able to reach a
 * destructive action at all — and none of these languages needs one to say it naturally.
 */
const SCRAP_BY_LANG: Record<string, string[]> = {
	en: ["scrap that", "scrap last message", "scrap the last message", "scratch that", "disregard that", "ignore that", "forget that", "delete that message", "delete last message", "delete the last message"],
	es: ["descarta eso", "olvida eso", "ignora eso", "borra el último mensaje"],
	fr: ["oublie ça", "annule ça", "ignore ça", "supprime le dernier message"],
	de: ["vergiss das", "streich das", "ignorier das", "letzte nachricht löschen"],
	it: ["dimentica questo", "ignora questo", "cancella l'ultimo messaggio"],
	pt: ["esquece isso", "ignora isso", "apaga a última mensagem"],
	zh: ["取消这条", "删掉这条", "忽略这条", "刚才那句不算"],
	ja: ["今のなし", "取り消して", "今のは無視して"],
	ko: ["방금 취소", "방금 건 취소", "무시해 줘"],
	hi: ["इसे हटाओ", "भूल जाओ"],
};

/** "Mute" phrasings per language (2-letter code). Whole-utterance only. English is the
 *  built-in baseline; other-language users add their own words in Settings → Voice. */
const MUTE_BY_LANG: Record<string, string[]> = {
	en: ["mute", "mute mic", "mute the mic", "mute microphone", "mute yourself", "stop listening"],
	es: ["silencio", "silenciar", "cállate"],
	fr: ["muet", "coupe le micro", "silence"],
	de: ["stumm", "stummschalten", "sei still"],
	it: ["muto", "silenzia"],
	pt: ["mudo", "silenciar"],
	zh: ["静音", "闭麦", "别听了"],
	ja: ["ミュート", "消音"],
	ko: ["음소거"],
	hi: ["म्यूट", "चुप"],
};

/** The 2-letter language key for the command maps, defaulting to English. */
function langKey(lang?: string): string {
	return (lang || "en").slice(0, 2).toLowerCase();
}

/** The script a configured language is written in — for language-confirmation (#126). A
 *  configured language pins its script; a transcript in a different script is a mis-detection,
 *  not a real language switch. Languages we can't map return null (never flagged). */
const SCRIPT_BY_LANG: Record<string, RegExp> = {
	en: /\p{Script=Latin}/u,
	es: /\p{Script=Latin}/u,
	fr: /\p{Script=Latin}/u,
	de: /\p{Script=Latin}/u,
	it: /\p{Script=Latin}/u,
	pt: /\p{Script=Latin}/u,
	zh: /\p{Script=Han}/u,
	ja: /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u,
	ko: /\p{Script=Hangul}/u,
	hi: /\p{Script=Devanagari}/u,
};

/**
 * Does a transcript look like a DIFFERENT language than the configured one (#126)? Judged by
 * script, not content: if the configured language expects Latin but the transcript is mostly
 * Hangul/Kana/Han, the STT mis-detected the language — the app should ask rather than respond
 * in it. Conservative: returns false for an unknown configured language, empty/too-short text,
 * or when at most half the letters are foreign (so a stray glyph never trips it). Pure + tested.
 */
export function transcriptLanguageMismatch(text: string, lang?: string): boolean {
	const expected = SCRIPT_BY_LANG[langKey(lang)];
	if (!expected) return false; // language we don't map → never flag
	const letters = (text || "").replace(/[^\p{L}]/gu, ""); // drop spaces/digits/punct/emoji
	if (letters.length < 2) return false; // too little signal to judge
	let foreign = 0;
	for (const ch of letters) if (!expected.test(ch)) foreign++;
	return foreign > letters.length / 2; // majority in another script → mis-detection
}

/** Normalize a transcript for matching. Lives in `./normalize.js` (#334) because the noise
 *  filter in `audio.ts` needs the SAME answer — two normalisers with different ideas of what
 *  punctuation is are what let `"Stop-stop."` miss a configured `"stop stop"`. */
const normalizeTranscript = normalizeSpeech;

/**
 * "Repeat" phrasings per language (2-letter code) — ONLY the agent's configured
 * language matches, so an English agent never triggers on a Chinese phrase and vice
 * versa. Whole-utterance matches only (high precision). Data, not regex, so adding a
 * language is a list edit.
 */
const REPEAT_BY_LANG: Record<string, string[]> = {
	en: ["repeat", "repeat that", "repeat it", "repeat again", "repeat please", "say again", "say that again", "say it again", "again please", "come again", "pardon", "what did you say"],
	zh: ["再说一遍", "再说一次", "重复一遍", "再来一遍"],
	es: ["repite", "repítelo", "otra vez", "qué dijiste"],
	fr: ["répète", "répétez", "encore une fois"],
	de: ["wiederhole", "nochmal", "wie bitte"],
	it: ["ripeti", "un'altra volta"],
	pt: ["repita", "de novo"],
	ja: ["もう一度", "もう一回"],
	ko: ["다시", "다시 말해줘", "다시 말해 줘"],
	hi: ["फिर से कहो", "दोबारा कहो"],
};

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does an already-normalized transcript match a configured command phrase?
 *  - A SINGLE-word phrase ("mute") must BE the whole utterance — precision, so "mute" never
 *    fires inside "mute the alarm".
 *  - A MULTI-word phrase ("mute mute", "stop listening") matches the whole utterance OR appears
 *    as a contiguous whole-word run inside it ("okay mute mute now" → matches). Multi-word
 *    phrases are distinctive enough that a whole-word substring match won't hijack normal speech,
 *    and it's what makes a two-word wake/mute phrase usable in a longer utterance.
 * "mute mute" is ONE two-word phrase (space-preserved by the delimiter parse), so "mute" alone
 * — only half the phrase — does NOT match.
 *
 * `opts.whole` forces the single-word rule onto a phrase of ANY length: the utterance must BE the
 * phrase. Used by the destructive `scrap` command (#342), where the substring reading would fire
 * on "don't scrap that, keep it" — see SCRAP_BY_LANG.
 */
export function phraseMatchesTranscript(normalizedTranscript: string, phrase: string, opts?: { whole?: boolean }): boolean {
	const p = normalizeTranscript(phrase);
	if (!p) return false;
	if (normalizedTranscript === p) return true;
	if (opts?.whole) return false; // whole-utterance only, regardless of word count
	if (!p.includes(" ")) return false; // single word → whole-utterance only
	return new RegExp(`(?:^| )${escapeRegExp(p)}(?: |$)`).test(normalizedTranscript);
}

/**
 * Detect a hands-free voice COMMAND ("repeat" / "mute") in a transcript. A single-word command
 * matches only when the whole utterance IS the command (punctuation ignored), so a normal
 * sentence containing the word isn't hijacked; a multi-word command phrase also matches when it
 * appears as a whole-word run inside the utterance (see {@link phraseMatchesTranscript}). Built-in
 * phrasings are scoped to the agent's `lang` (the configured voice language) — an English agent
 * won't trigger on a Chinese phrase. Which phrases are in force for each command — including the
 * rule that an explicitly bound phrase outranks a built-in (#385) — is decided in ONE place,
 * {@link commandPhrases}, so this matcher and `splitTrailingCommand` cannot disagree about it.
 */
export function matchVoiceCommand(
	text: string,
	words?: VoiceCommandWords,
	lang?: string,
	state?: Partial<CommandMatchState>,
): VoiceCommand | null {
	// A transcript captured while the agent's own voice may be in the microphone, and not yet
	// finished, is not evidence of anything (#386) — see commandStateFor.
	if (state?.judgeable === false) return null;
	const t = normalizeTranscript(text);
	const pick = (command: VoiceCommand) => commandPhrases(command, words, lang);
	// `state.whole` raises EVERY phrase to the whole-utterance rule for the same reason `opts.whole`
	// raises `scrap` to it: when a match would be acted on despite the transcript being untrustworthy,
	// the run-inside-a-sentence reading is the one that fires on somebody else's words.
	const hit = (phrases: string[], opts?: { whole?: boolean }) =>
		phrases.some((p) => phraseMatchesTranscript(t, p, { whole: opts?.whole === true || state?.whole === true }));
	// "next" is a command ONLY where something can act on it (#277). The voice stack has no
	// idea what an agent roster is, so the consumer opting in — by passing a handler — is what
	// turns the word on. Everywhere else ("next" said to the Coder's Co-pilot, which has no
	// switcher) it stays an ordinary word and reaches the agent as speech, which is the
	// conservative half of the same rule that keeps "what's next?" a message.
	const canSwitch = state?.canSwitch === true;

	// Order matters. "unmute" is checked FIRST and only while muted: several languages build
	// the unmute phrase out of the mute phrase (de "stummschaltung aufheben" contains "stumm"),
	// so a mute-first order would swallow it. English is safe by whole-utterance matching —
	// other languages are not.
	if (state?.muted) {
		// While muted the ONLY meaningful commands are unmute, exit and next. Checking mute here
		// would be a no-op at best; checking repeat would speak while the user asked for silence.
		// "next" IS meaningful muted, deliberately: mute silences the microphone, not the user's
		// ability to leave. Being unable to walk away from a muted agent by voice is the exact
		// "it demands the screen" failure #277 exists to remove.
		if (hit(pick("unmute"))) return "unmute";
		if (hit(pick("exit"))) return "exit";
		if (canSwitch && hit(pick("next"))) return "next";
		// Muted for the same reason `next` is: mute silences the microphone, not the ability to
		// leave. Being unable to reverse a transfer without unmuting first would put the screen back
		// in the loop at exactly the moment the user realises they are in the wrong conversation.
		if (state?.canBack && hit(pick("back"), { whole: true })) return "back";
		return null;
	}
	// Not muted: unmute is meaningless, and matching it here would fire on someone SAYING the
	// word ("say unmute to turn the mic back on") rather than commanding it.
	if (hit(pick("exit"))) return "exit";
	if (canSwitch && hit(pick("next"))) return "next";
	// "back" (#279) — after `exit`, which owns "back to text" and must keep it: leaving voice is
	// the smaller, recoverable reading of an ambiguous "back". `{ whole: true }` and the final-only
	// flag are what keep "let's go back and fix the parser" a message — see BACK_BY_LANG.
	if (state?.canBack && hit(pick("back"), { whole: true })) return "back";
	// "scrap" (#342). Gated on `canScrap` for the same two reasons `next` is gated on `canSwitch`,
	// and one more. (1) A surface with no delete path — the Coder's Co-pilot — must leave the word
	// as ordinary speech rather than swallow it. (2) The consumer passing a handler is what turns
	// it on, so nothing here has to know what a transcript is. (3) It is the flag the caller drops
	// on INTERIM transcripts: a partial of "scrap that idea and let's move on" is momentarily
	// exactly "scrap that", so a destructive command must only ever be judged on a FINAL utterance,
	// where the whole-utterance rule below can actually see the whole utterance.
	if (state?.canScrap && hit(pick("scrap"), { whole: true })) return "scrap";
	if (hit(pick("repeat"))) return "repeat";
	if (hit(pick("mute"))) return "mute";
	return null;
}

/**
 * Which kind of transcript is being judged. A PARTIAL is the recognizer's running guess at a
 * sentence still being spoken; a FINAL is an utterance the user finished.
 */
export type TranscriptKind = "partial" | "final";

/** The matching rules in force for ONE transcript — every field derived by {@link commandStateFor}
 *  from the kind of transcript the caller holds and the state it was captured in. */
export interface CommandMatchState {
	muted: boolean;
	canSwitch: boolean;
	canScrap: boolean;
	/** May THIS transcript reverse a transfer (#279)? False on every partial — see BACK_BY_LANG. */
	canBack: boolean;
	/** May this transcript be judged for a command at all? False for a partial captured while the
	 *  agent's own voice may be in the microphone (#386). */
	judgeable: boolean;
	/** Every phrase must BE the whole utterance — the `scrap` rule (#342) applied to every command,
	 *  because a phrase matched as a run INSIDE this transcript may be the agent's words (#386). */
	whole: boolean;
}

/**
 * The `state` argument for {@link matchVoiceCommand}, derived from the kind of transcript the
 * caller holds — so the one rule that depends on that kind is applied in a single place.
 *
 * `scrap` (#342) is the only DESTRUCTIVE word in the vocabulary, and it is the only one that is
 * unsafe to judge on a partial: "scrap that idea and let's move on" passes through the partial
 * "scrap that" on its way to being said, and the whole-utterance rule that makes the command
 * precise cannot see a whole utterance yet. Three of the five matcher call sites feed partials
 * (the dictation gate, the always-on control listener, the interim keyword path) and two feed
 * finished turns.
 *
 * That distinction used to be an OMISSION at three call sites plus a paragraph each explaining
 * why the flag was missing — a shape whose failure mode is a reader "fixing" the inconsistency.
 * Here the kind is stated at every site and a partial cannot enable the command even when the
 * consumer has one: the flag is dropped on the way in, not merely never passed.
 *
 * ── `echoing`: the agent's own voice (#386)
 *
 * Four paths reason about speaker→mic bleed; the ONE that runs exclusively inside the echo window —
 * the always-on control listener — had no guard at all, so the agent saying *"Stop me if this is
 * wrong"* produced a first interim of exactly `"stop"`, which whole-utterance-matched the built-in
 * exit word and tore hands-free down with the user silent. Same shape for *"say mute mute to
 * silence me"* and *"the next agent in the chain"*.
 *
 * The blunt guard the other paths use — drop everything while echoing — cannot be applied there: it
 * would remove mute-during-TTS, which is the single capability that listener was built for (#153),
 * and `isEchoing` cannot separate the agent's voice from the user's precisely in the window where
 * both are possible. So the bar goes UP instead of the door closing:
 *
 *   - a PARTIAL is not judged at all — it is the recognizer's guess at a sentence still being
 *     spoken, and "the whole utterance so far" is exactly what makes a bare word match a word the
 *     agent is in the middle of saying;
 *   - a FINAL is judged, but whole-utterance only — no run inside a longer sentence.
 *
 * A deliberate "mute mute" still fires, on the final rather than the interim. What is paid for that:
 * a command spoken while the agent talks lands when the recognizer closes the utterance (a beat
 * later, not a keystroke later), and a command buried in a longer sentence *while the agent is
 * speaking* no longer fires — everywhere else it still does. Single words are NOT dropped
 * wholesale: #377's rule stands, and swallowing a real "commit" would be the worse failure.
 */
export function commandStateFor(
	kind: TranscriptKind,
	ctx: { muted?: boolean; canSwitch?: boolean; canScrap?: boolean; canBack?: boolean; echoing?: boolean },
): CommandMatchState {
	const echoing = ctx.echoing === true;
	return {
		muted: ctx.muted === true,
		canSwitch: ctx.canSwitch === true,
		canScrap: kind === "final" && ctx.canScrap === true,
		// `back` (#279) takes scrap's final-only rule for a different reason than scrap's: not that
		// it destroys anything, but that every phrase for it is ordinary speech, and a partial is
		// exactly "go back" on the way to "go back and fix the parser". Dropped on the way IN, like
		// canScrap, so a call site cannot enable it on a partial by forgetting.
		canBack: kind === "final" && ctx.canBack === true,
		judgeable: !(echoing && kind === "partial"),
		whole: echoing,
	};
}

/**
 * Does this transcript carry the configured STOP-SPEECH keyword while the agent is actually
 * talking (#153)? Substring + case-insensitive, unlike every other command here: it interrupts
 * playback, so hearing it inside a longer sentence is the point.
 *
 * Gated on the agent SPEAKING, which is what contains a false match — there is nothing to
 * interrupt otherwise, and the two call sites (the control listener and the main result path)
 * both check it BEFORE the echo guard would drop the result as the agent's own voice.
 *
 * An empty or whitespace-only keyword means the feature is OFF. It used to mean "match any text
 * containing a space", because the emptiness test ran on the un-trimmed setting.
 */
export function matchesStopSpeech(s: { keyword: string | undefined; text: string; ttsSpeaking: boolean }): boolean {
	if (!s.ttsSpeaking) return false;
	const kw = (s.keyword ?? "").trim().toLowerCase();
	if (!kw) return false;
	return s.text.toLowerCase().includes(kw);
}

/**
 * Should the ALWAYS-ON background control-word listener be running right now (#153)? It's a
 * lightweight dictation loop, SEPARATE from the main recording pipeline, whose only job is to
 * catch a control word (mute / stop) at ANY moment — while TTS plays, while the agent is
 * processing, while the mic is muted. It runs whenever voice is engaged BUT yields while the
 * MAIN recorder is actively capturing a user turn (the main transcription path already checks
 * control words then, and two concurrent recognizers on the same browser API fight). So:
 *   engaged (voice mode, not plain text) AND NOT the main mic actively recording.
 */
export function shouldRunControlListener(s: { engaged: boolean; mainRecording: boolean }): boolean {
	return s.engaged && !s.mainRecording;
}

/**
 * Should a live transcript chunk be scanned for control words (#228)?
 *
 * The control listener above yields whenever the main mic is capturing, which left a hole: it
 * assumed the main path checks control words during capture, and that is only true for browser
 * DICTATION (which emits interim results live). The Whisper/OpenAI path records with
 * MediaRecorder and produces nothing until the clip is uploaded — so for the whole recording
 * window nobody was checking, and "mute" said mid-turn did nothing until end-of-turn (or never,
 * if it wasn't the entire utterance).
 *
 * In that mode the speech GATE is already running a browser recognizer over the same audio for
 * noise filtering, and already has the words. This is the predicate for using them: scan the
 * gate's transcript exactly when the main path can't do it itself.
 *
 * `paused` covers the reply-in-flight window (the gate keeps running across it) and `echoing`
 * the TTS tail, so the agent's own voice can't issue commands to it.
 */
export function shouldScanGateTranscript(s: {
	commandsEnabled: boolean;
	mainUsesBrowserSpeech: boolean;
	paused: boolean;
	echoing: boolean;
}): boolean {
	if (!s.commandsEnabled) return false;
	// Browser dictation already checks control words on its own interim results; scanning the
	// gate too would double-fire the same command from two recognizers on the same audio.
	if (s.mainUsesBrowserSpeech) return false;
	return !s.paused && !s.echoing;
}

/**
 * Detect a trailing STOP-WORD ("...do the thing, copy") — the user's spoken "I'm done,
 * process it now" marker. Returns `ended` (a stop-word closed the turn) and `text` with
 * the stop-word removed. A stop-word ALONE ("copy") → `{ ended: true, text: "" }` (end
 * the turn, nothing to send). Off unless `stopWords` is configured — the word is usually
 * a normal word, so it must be opt-in to avoid hijacking ordinary speech.
 */
export function stripStopWord(text: string, stopWords?: string[]): { ended: boolean; text: string } {
	if (!stopWords?.length) return { ended: false, text };
	// Compare on a normalized copy but slice the ORIGINAL so casing/spacing is preserved.
	const cleaned = trimTrailingPunctuation(text);
	const norm = normalizeTranscript(cleaned);
	for (const raw of stopWords) {
		const w = normalizeTranscript(raw);
		if (!w) continue;
		if (norm === w) return { ended: true, text: "" };
		if (norm.endsWith(` ${w}`)) {
			const kept = dropNormalizedSuffix(cleaned, w);
			if (kept !== null) return { ended: true, text: kept };
		}
	}
	return { ended: false, text };
}

/**
 * Cut the trailing run of the ORIGINAL text whose normalisation IS `phrase`, or null when no
 * whitespace boundary lines up with it.
 *
 * It used to drop the last N whitespace-separated tokens, N = the phrase's word count. Once
 * `normalizeSpeech` began spacing hyphens (#334) that arithmetic broke: `"run the tests,
 * stop-stop"` is FOUR tokens but SIX normalised words, so a two-word stop-word ate `"tests,"`
 * along with the compound and sent `"run the"`. Walking real boundaries can't drift — the cut
 * is always at a place the original actually has.
 */
function dropNormalizedSuffix(cleaned: string, phrase: string): string | null {
	const parts = cleaned.split(/(\s+)/); // separators kept, so slices rejoin exactly
	// Highest index first = shortest candidate tail, so the cut is minimal.
	for (let i = parts.length - 1; i >= 0; i--) {
		const tail = parts.slice(i).join("");
		if (normalizeTranscript(tail) !== phrase) continue;
		return trimTrailingPunctuation(cleaned.slice(0, cleaned.length - tail.length)).trim();
	}
	return null;
}

const TABLES: Record<VoiceCommand, Record<string, string[]>> = {
	repeat: REPEAT_BY_LANG,
	mute: MUTE_BY_LANG,
	unmute: UNMUTE_BY_LANG,
	exit: EXIT_BY_LANG,
	next: NEXT_BY_LANG,
	back: BACK_BY_LANG,
	scrap: SCRAP_BY_LANG,
};
const ALL_COMMANDS = Object.keys(TABLES) as VoiceCommand[];

/**
 * Is `phrase` one the user has explicitly bound to something OTHER than `command`? (#385)
 *
 * Two matchers, because the two kinds of binding are matched differently and the reservation has
 * to be as wide as the matcher that will act on it:
 *  - a command LIST is compared phrase-for-phrase, the same equality {@link phraseMatchesTranscript}
 *    starts from;
 *  - the stop-speech KEYWORD is a case-insensitive SUBSTRING matcher ({@link matchesStopSpeech}), so
 *    it owns every built-in phrase that CONTAINS it, not merely the one that equals it. A keyword of
 *    `"stop"` therefore reserves the built-in `"stop stop"` too: saying that phrase IS saying the
 *    keyword, and the explicit binding is what the user chose.
 */
function reservedElsewhere(command: VoiceCommand, phrase: string, words?: VoiceCommandWords): boolean {
	if (!words) return false;
	const p = normalizeTranscript(phrase);
	if (!p) return false;
	for (const other of ALL_COMMANDS) {
		if (other === command) continue;
		if (words[other]?.some((w) => normalizeTranscript(w) === p)) return true;
	}
	const stop = normalizeTranscript(words.stopSpeech ?? "");
	return !!stop && p.includes(stop);
}

/**
 * The phrase list actually in force for one command — THE precedence rule, in one place (#385).
 *
 * **An explicit binding always outranks a built-in.** In two directions, and the second is the one
 * that was missing:
 *
 *  1. Words configured FOR this command replace the built-ins for it (unchanged).
 *  2. A phrase the user bound to a DIFFERENT action is removed from this command's built-ins.
 *
 * Rule (2) is the reported bug. An account with `stopSpeechKeyword: "stop stop"` and an empty
 * `exitWords` got both meanings for one phrase, chosen by whether TTS happened to be playing at
 * that instant: speaking → stop the speech (what they configured), silent → fall through to the
 * built-in English exit list, which contains `"stop"` and `"stop stop"` (#331), and hands-free was
 * torn down. The destructive reading was the one they never chose, and there was no way to say so —
 * the only lever was to bind `exitWords` to some other phrase, i.e. keep the feature and move it.
 *
 * What this deliberately does NOT change: a BLANK field still means "use ours". Flipping blank to
 * mean "off" is the other half of #385 and it is not a code change — it silently removes working
 * `repeat`/`mute`/`exit` from every user who never opened the panel, so it needs a backfill that
 * writes the built-ins into their settings first. The built-ins are also language-derived data
 * (they follow `lang`), so freezing today's English list into a user's config would break the
 * property that changing your voice language changes your command words. That trade belongs in its
 * own change, with a migration. This one resolves the collision, which is the destructive part, and
 * changes behaviour for nobody who has not explicitly bound a colliding phrase.
 *
 * Exported so callers can strip a spoken command out of a message without re-deriving any of it.
 */
export function commandPhrases(command: VoiceCommand, words?: VoiceCommandWords, lang?: string): string[] {
	const custom = words?.[command];
	if (custom?.length) return custom;
	const table = TABLES[command];
	const builtIn = table[langKey(lang)] ?? table.en;
	return builtIn.filter((p) => !reservedElsewhere(command, p, words));
}

/**
 * Split a spoken turn into "the command at the end" + "what the user actually said".
 *
 * A control word spoken at the END of a turn ("run the tests, mute") is a control word AND a
 * finished message — the same contract stop-words already have. Treating it as command-only
 * threw the message away: the user dictated a request, asked for silence, and the request
 * vanished. Treating it as message-only left them talking to a mic that never muted.
 *
 * Returns the command (if any) and the message with the command phrase removed. A turn that
 * IS the command yields an empty message, so nothing is sent.
 *
 * `scrap` (#342) is deliberately ABSENT from the candidate list. It matches whole-utterance only,
 * so there is never a message half to keep — and the trailing form is precisely the dangerous one:
 * "let's rewrite the parser, scrap that" would delete the previous exchange AND send a truncated
 * request. Callers check for it separately, on a final turn, before reaching here.
 *
 * `back` (#279) is absent for the same reason and one more: "ask it about the parser, then take me
 * back" is a sentence about a plan, not two instructions, and the trailing form cannot tell the
 * difference. Whole-utterance only, judged on the final — see BACK_BY_LANG.
 */
export function splitTrailingCommand(
	text: string,
	words?: VoiceCommandWords,
	lang?: string,
	state?: { muted?: boolean; canSwitch?: boolean },
): { command: VoiceCommand | null; text: string } {
	// Same candidate set and ordering as matchVoiceCommand, so the two can never disagree
	// about what a word means.
	const canSwitch = state?.canSwitch === true;
	const candidates: VoiceCommand[] = state?.muted
		? (["unmute", "exit", ...(canSwitch ? (["next"] as const) : [])] as VoiceCommand[])
		: (["exit", ...(canSwitch ? (["next"] as const) : []), "repeat", "mute"] as VoiceCommand[]);
	const norm = normalizeTranscript(text);

	// The turn IS the command → nothing to send.
	for (const cmd of candidates) {
		if (commandPhrases(cmd, words, lang).some((p) => normalizeTranscript(p) === norm)) {
			return { command: cmd, text: "" };
		}
	}

	// A command phrase at the END → act on it and keep what came before. Restricted to
	// MULTI-WORD phrases, deliberately: `phraseMatchesTranscript` already refuses to fire a
	// single-word command that isn't the whole utterance, precisely so ordinary speech isn't
	// hijacked, and stripping a trailing bare word would reintroduce that. "don't forget to
	// mute" must stay a message — silently truncating it AND muting is far worse than making
	// the user pause before saying a one-word command.
	for (const cmd of candidates) {
		const multiWord = commandPhrases(cmd, words, lang).filter((p) => normalizeTranscript(p).includes(" "));
		if (!multiWord.length) continue;
		const stripped = stripStopWord(text, multiWord);
		if (stripped.ended && stripped.text.trim()) return { command: cmd, text: stripped.text };
	}
	return { command: null, text };
}

/**
 * Classify a browser SpeechRecognition / STT error (issue: voice error-log spam).
 * - "soft"           → no-speech / empty: not an error, just recycle the mic.
 * - "mic-unavailable"→ permission denied or no capture device. A user-ENVIRONMENT
 *   state, not a platform bug: stop the loop (don't retry into a dead mic) and show a
 *   clear hint — do NOT flood the durable error log.
 * - "error"          → a genuine failure (Whisper 400/401, etc.) worth reporting.
 */
export type VoiceErrorKind = "soft" | "mic-unavailable" | "error";
const MIC_UNAVAILABLE = new Set(["not-allowed", "service-not-allowed", "audio-capture", "audio-busy"]);
export function classifyVoiceError(err: string | null | undefined): VoiceErrorKind {
	if (!err || err === "no-speech") return "soft";
	if (MIC_UNAVAILABLE.has(err)) return "mic-unavailable";
	return "error";
}
/**
 * Should a failed turn offer **Retry** (#421)?
 *
 * The user's ask was "see the message and know what to do — retry now or later", and the two cases
 * need different answers because the right action differs. A timeout, a 5xx, a platform deploy or a
 * dropped stream will very likely succeed on a second attempt with the SAME clip, which is still in
 * hand. A 400 or 401 will fail again identically — the key is wrong, or the audio is unusable — so
 * a Retry button there is a dead affordance that costs the user's own OpenAI credit to discover.
 *
 * Judged on the message rather than a code because the message is what the bubble carries, and it
 * is the only thing that survives into the durable log. Conservative in the safe direction: an
 * unrecognised failure gets no Retry, so a new error shape cannot silently start charging people
 * for a retry that was never going to work.
 */
export function isRetryableVoiceError(err: string | null | undefined): boolean {
	if (!err) return false;
	const e = err.toLowerCase();
	// A permission/validation refusal is deterministic — the same clip and key produce the same
	// answer. Checked FIRST: "Whisper error 400: …" also contains the word "error".
	if (/\b4\d\d\b|too short|invalid|unsupported|not-allowed|audio-capture|audio-busy/.test(e)) return false;
	return /timed out|timeout|\b5\d\d\b|updating|stream failed|whisper failed|network|load failed|failed to fetch/.test(e);
}

/** Human hint for a mic-unavailable error code. */
export function micUnavailableMessage(err: string): string {
	if (err === "audio-capture") return "No microphone found — check your device.";
	if (err === "audio-busy") return "Microphone is in use by another app or tab — close it and try again.";
	return "Microphone blocked — allow mic access in your browser settings.";
}

/**
 * Translate a `getUserMedia` failure into the SAME error vocabulary `classifyVoiceError` already
 * speaks, so ONE classifier covers both ways the mic can refuse to open (#284).
 *
 * The two APIs report the same conditions under different names: Web Speech says `"not-allowed"`
 * / `"audio-capture"`, `getUserMedia` throws a DOMException named `"NotAllowedError"` /
 * `"NotFoundError"`. `classifyVoiceError` only ever knew the first set, so a denied mic on the
 * hands-free START path fell through to the generic `"error"` branch — which is why that path
 * "does not reach" the existing helpers and reverted in silence instead of saying why.
 *
 * `NotReadableError` (the device is held by another tab or app) has no Web Speech equivalent at
 * all, hence the new `audio-busy` code: it is the case a user is least able to guess.
 */
export function normalizeMediaError(err: unknown): string {
	const name = typeof err === "object" && err !== null && "name" in err ? String((err as { name: unknown }).name) : String(err ?? "");
	switch (name) {
		case "NotAllowedError":
		case "PermissionDeniedError":
		case "SecurityError":
			return "not-allowed";
		case "NotFoundError":
		case "DevicesNotFoundError":
			return "audio-capture";
		case "NotReadableError":
		case "TrackStartError":
			return "audio-busy";
		default:
			// Already a Web Speech code (the STT layer rethrows those verbatim) → pass it through
			// so the one classifier keeps working; anything else stays a real, reportable error.
			return name;
	}
}
