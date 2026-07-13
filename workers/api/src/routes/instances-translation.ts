/**
 * Under-message translation + transliteration (the console Assistant's learning
 * display). Split from instances.ts (the instances-apply.ts precedent): config
 * GET/PUT, the /translate endpoint with its persistent per-message gloss cache
 * (message_gloss, migration 0042), and the helper that attaches cached glosses
 * to a messages payload so history renders glossed in the same paint.
 */
import type { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { runUserWorkersAi } from "../lib/user-ai.js";
import type { Env } from "../types.js";
import { readInstanceConfig } from "./instances-apply.js";
import { requireOwnedInstance } from "./instances-runtime.js";

/** Languages the under-message translation can target. SINGLE source of truth —
 *  `tag` (BCP-47) is what the console's spoken-translation voice uses, so the
 *  client never maintains its own name→tag map that could drift. */
export const TRANSLATION_LANGUAGES: ReadonlyArray<{ name: string; tag: string }> = [
	{ name: "English", tag: "en-US" },
	{ name: "Spanish", tag: "es-ES" },
	{ name: "French", tag: "fr-FR" },
	{ name: "German", tag: "de-DE" },
	{ name: "Italian", tag: "it-IT" },
	{ name: "Portuguese", tag: "pt-BR" },
	{ name: "Chinese (Simplified)", tag: "zh-CN" },
	{ name: "Japanese", tag: "ja-JP" },
	{ name: "Korean", tag: "ko-KR" },
	{ name: "Hindi", tag: "hi-IN" },
	{ name: "Russian", tag: "ru-RU" },
	{ name: "Arabic", tag: "ar-SA" },
	{ name: "Ukrainian", tag: "uk-UA" },
	{ name: "Polish", tag: "pl-PL" },
	{ name: "Dutch", tag: "nl-NL" },
	{ name: "Turkish", tag: "tr-TR" },
];

const languageByName = (name: unknown) => TRANSLATION_LANGUAGES.find((l) => l.name === name);

export interface TranslationConfig {
	enabled: boolean;
	target: string;
	targetTag: string;
	transliterate: boolean;
	wordTap: boolean;
	fontSize: "small" | "medium" | "large";
}

/** Normalize whatever is stored at instance config.translation. */
export function translationConfigOf(cfg: Record<string, unknown>): TranslationConfig {
	const t = (cfg.translation && typeof cfg.translation === "object" ? cfg.translation : {}) as Record<string, unknown>;
	const lang = languageByName(t.target) ?? TRANSLATION_LANGUAGES[0];
	return {
		enabled: t.enabled === true,
		target: lang.name,
		targetTag: lang.tag,
		transliterate: t.transliterate === true,
		// Tap a single word to hear it (long-press still selects). Default ON.
		wordTap: t.wordTap !== false,
		// Learning-display text size (interlinear words + gloss lines).
		fontSize: t.fontSize === "small" || t.fontSize === "large" ? t.fontSize : "medium",
	};
}

async function contentHashOf(text: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface Gloss {
	translation: string;
	transliteration?: string;
	pairs?: Array<[string, string]>;
}

/**
 * Attach cached glosses to assistant messages (mutates in place) so translated
 * history renders in the SAME paint as the messages — no per-message fetch
 * round trips. Only uncached (new) messages translate client-side. Best-effort:
 * a failure here must never block the messages themselves.
 */
export async function attachGlossesToMessages(
	env: Env,
	instanceId: string,
	userId: string,
	messages: Array<Record<string, unknown>>,
): Promise<void> {
	try {
		const cfg = await readInstanceConfig(env, instanceId, userId);
		const t = translationConfigOf(cfg);
		if (!t.enabled || !messages.length) return;
		const transliterate = t.transliterate ? 1 : 0;
		const assistant = messages.filter((m) => m.role === "assistant" && typeof m.content === "string" && (m.content as string).trim());
		const hashes = new Map<string, string>(); // content → hash
		for (const m of assistant) {
			const content = (m.content as string).slice(0, 2000).trim();
			hashes.set(m.content as string, await contentHashOf(content));
		}
		const unique = [...new Set(hashes.values())];
		if (!unique.length) return;
		const placeholders = unique.map((_, i) => `?${i + 4}`).join(", ");
		const rows = await env.DB.prepare(
			`SELECT content_hash, translation, transliteration, pairs FROM message_gloss
			 WHERE instance_id = ?1 AND target = ?2 AND transliterate = ?3 AND content_hash IN (${placeholders})`,
		)
			.bind(instanceId, t.target, transliterate, ...unique)
			.all<{ content_hash: string; translation: string; transliteration: string | null; pairs: string | null }>();
		const byHash = new Map((rows.results || []).map((r) => [r.content_hash, r]));
		for (const m of assistant) {
			const row = byHash.get(hashes.get(m.content as string) || "");
			// Skip stale pre-pairs entries in transliterate mode — the client
			// re-fetches those, which recomputes + upgrades the cache.
			if (!row || (transliterate && !row.pairs)) continue;
			let pairs: Array<[string, string]> | undefined;
			try { pairs = row.pairs ? (JSON.parse(row.pairs) as Array<[string, string]>) : undefined; } catch { /* flat */ }
			m.gloss = { translation: row.translation, transliteration: row.transliteration || undefined, pairs } satisfies Gloss;
		}
	} catch { /* glosses are an enhancement — never block messages */ }
}

export function registerTranslationRoutes(router: Hono<{ Bindings: Env }>): void {
	/** Read the under-message translation config (console Assistant feature). */
	router.get("/:instanceId/translation", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const cfg = await readInstanceConfig(c.env, instanceId, session.uid);
		return c.json({ translation: translationConfigOf(cfg), languages: TRANSLATION_LANGUAGES });
	});

	/** Save the under-message translation config. */
	router.put("/:instanceId/translation", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown; target?: unknown; transliterate?: unknown; wordTap?: unknown; fontSize?: unknown };
		const lang = languageByName(body.target) ?? TRANSLATION_LANGUAGES[0];
		const translation = {
			enabled: body.enabled === true,
			target: lang.name,
			transliterate: body.transliterate === true,
			wordTap: body.wordTap !== false,
			fontSize: body.fontSize === "small" || body.fontSize === "large" ? body.fontSize : "medium",
		};
		const cfg = await readInstanceConfig(c.env, instanceId, session.uid);
		cfg.translation = translation;
		await c.env.DB.prepare("UPDATE agent_instances SET config = ?1, updated_at = datetime('now') WHERE id = ?2 AND user_id = ?3")
			.bind(JSON.stringify(cfg), instanceId, session.uid)
			.run();
		return c.json({ translation: { ...translation, targetTag: lang.tag } });
	});

	/** Translate a chat message into the instance's configured target language — the
	 *  console renders the result beneath the original message. Platform Workers AI
	 *  when enabled (free), else the user's BYOK key. */
	router.post("/:instanceId/translate", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const cfg = await readInstanceConfig(c.env, instanceId, session.uid);
		const t = translationConfigOf(cfg);
		if (!t.enabled) throw new HttpError(400, "Translation is not enabled for this instance");
		const { target, transliterate } = t;
		const body = (await c.req.json().catch(() => ({}))) as { text?: unknown };
		const text = typeof body.text === "string" ? body.text.slice(0, 2000).trim() : "";
		if (!text) throw new HttpError(400, "text required");

		// Persistent cache: each message is glossed ONCE, then served instantly on every
		// later page load (no pop-in re-computation, no repeated AI spend).
		const contentHash = await contentHashOf(text);
		const cached = await c.env.DB.prepare(
			"SELECT translation, transliteration, pairs FROM message_gloss WHERE instance_id = ?1 AND content_hash = ?2 AND target = ?3 AND transliterate = ?4",
		)
			.bind(instanceId, contentHash, target, transliterate ? 1 : 0)
			.first<{ translation: string; transliteration: string | null; pairs: string | null }>();
		// A transliterate-mode entry cached before the word-pairs feature has no pairs —
		// treat it as a miss so it recomputes and UPGRADES in place (else old history
		// would show the flat line forever).
		if (cached && !(transliterate && !cached.pairs)) {
			let cachedPairs: Array<[string, string]> | undefined;
			try { cachedPairs = cached.pairs ? (JSON.parse(cached.pairs) as Array<[string, string]>) : undefined; } catch { /* re-serve without pairs */ }
			return c.json({ translation: cached.translation, transliteration: cached.transliteration || undefined, pairs: cachedPairs });
		}
		const saveGloss = async (translation: string, transliteration?: string, pairs?: Array<[string, string]>) => {
			try {
				await c.env.DB.prepare(
					"INSERT OR REPLACE INTO message_gloss (instance_id, content_hash, target, transliterate, translation, transliteration, pairs) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
				)
					.bind(instanceId, contentHash, target, transliterate ? 1 : 0, translation, transliteration ?? null, pairs ? JSON.stringify(pairs) : null)
					.run();
			} catch { /* cache write is best-effort */ }
		};
		const plainSystem = `You are a translator. Translate the user's message into ${target}. Output ONLY the translation — no quotes, no notes, no commentary.`;
		const system = transliterate
			? `You are a translator. Reply with ONLY a JSON object, no other text:\n` +
				`{"translation": "<the user's message translated into ${target}>", ` +
				`"pairs": [["<word from the ORIGINAL message>", "<its Latin transliteration — Hanyu Pinyin with tone marks for Chinese, Hepburn romaji for Japanese, Revised Romanization for Korean, standard romanization for other scripts; \\"\\" for punctuation or words already in Latin script>"], ...]}\n` +
				`The pairs must cover the ENTIRE original message, in order, split into natural words (e.g. 名字 is one word).`
			: plainSystem;
		const messages = [
			{ role: "system", content: system },
			{ role: "user", content: text },
		];
		// Parse the JSON-mode reply defensively; null = unparseable (caller retries/salvages).
		const parseGloss = (rawOut: string): { translation: string; transliteration: string; pairs?: Array<[string, string]> } | null => {
			try {
				const m = rawOut.match(/\{[\s\S]*\}/);
				if (!m) return null;
				const parsed = JSON.parse(m[0]) as { translation?: unknown; pairs?: unknown };
				const translation = typeof parsed.translation === "string" ? parsed.translation.trim() : "";
				if (!translation) return null;
				// Word-by-word [original, romanization] pairs for the interlinear display.
				const pairs = (Array.isArray(parsed.pairs) ? parsed.pairs : [])
					.flatMap((p): Array<[string, string]> => {
						if (!Array.isArray(p) || typeof p[0] !== "string" || !p[0]) return [];
						return [[p[0], typeof p[1] === "string" ? p[1] : ""]];
					})
					.slice(0, 400);
				// Flat transliteration derived from the pairs — the client's fallback line.
				return { translation, transliteration: pairs.map((p) => p[1]).filter(Boolean).join(" "), pairs: pairs.length ? pairs : undefined };
			} catch {
				return null;
			}
		};
		const runByok = async (msgs = messages): Promise<string> => {
			try {
				const r = (await runUserWorkersAi(c.env, session.uid, "claude-sonnet-4-6", {
					messages: msgs,
					maxTokens: 2000,
				}, { kind: "translate", instanceId })) as { response?: string };
				return (r.response || "").trim();
			} catch {
				return ""; // no key / provider error — salvage whatever we already have
			}
		};

		let raw = "";
		let viaPlatform = false;
		if (c.env.PLATFORM_AI_ENABLED === "true" && c.env.AI) {
			try {
				const r = (await c.env.AI.run(
					"@cf/meta/llama-3.3-70b-instruct-fp8-fast" as Parameters<Ai["run"]>[0],
					// Explicit max_tokens: the Workers AI default is small enough to TRUNCATE
					// a long pairs JSON mid-string → unparseable → gloss silently degraded.
					{ messages, max_tokens: 2048 },
				)) as { response?: string };
				raw = (r.response || "").trim();
				viaPlatform = !!raw;
			} catch { /* fall through to BYOK */ }
		}
		if (!raw) {
			raw = await runByok();
			viaPlatform = false;
		}
		if (!raw) throw new HttpError(502, "Translation failed — no AI provider responded (add an Anthropic API key in Profile, or try again)");
		if (!transliterate) {
			await saveGloss(raw);
			return c.json({ translation: raw });
		}
		let gloss = parseGloss(raw);
		// The platform model intermittently emits invalid JSON (unescaped quotes in
		// quote-heavy replies) — retry ONCE through BYOK Claude, which is far more
		// reliable at JSON, before degrading to a translation-only salvage.
		if (!gloss && viaPlatform) {
			const retry = await runByok();
			if (retry) {
				gloss = parseGloss(retry);
				if (!gloss) raw = retry; // salvage from the better model's output
			}
		}
		if (gloss) {
			await saveGloss(gloss.translation, gloss.transliteration, gloss.pairs);
			return c.json(gloss);
		}
		// Un-parseable model output: salvage the translation string if the reply LOOKS like
		// our JSON (never show raw JSON to the user), else treat the whole reply as the
		// translation. Deliberately NOT cached — a retry may parse cleanly next load.
		const salvage = raw.match(/"translation"\s*:\s*"((?:[^"\\]|\\.)*)"/);
		if (salvage) {
			try { return c.json({ translation: JSON.parse(`"${salvage[1]}"`) as string }); } catch { /* fall through */ }
		}
		if (raw.trimStart().startsWith("{")) {
			// JSON-shaped but unsalvageable. Last resort: ask for a PLAIN translation (that
			// prompt can't emit JSON), so the user gets a flat line NOW instead of a 502 that
			// replays on every page load; the flat cache entry counts as stale in
			// transliterate mode, so a later load recomputes and upgrades it to pairs.
			const plainMsgs = [
				{ role: "system", content: plainSystem },
				{ role: "user", content: text },
			];
			let plain = "";
			if (c.env.PLATFORM_AI_ENABLED === "true" && c.env.AI) {
				try {
					const r = (await c.env.AI.run(
						"@cf/meta/llama-3.3-70b-instruct-fp8-fast" as Parameters<Ai["run"]>[0],
						{ messages: plainMsgs, max_tokens: 2048 },
					)) as { response?: string };
					plain = (r.response || "").trim();
				} catch { /* fall through to BYOK */ }
			}
			if (!plain || plain.startsWith("{")) plain = await runByok(plainMsgs);
			if (plain && !plain.startsWith("{")) {
				await saveGloss(plain);
				return c.json({ translation: plain });
			}
			throw new HttpError(502, "Translation failed");
		}
		return c.json({ translation: raw });
	});
}
