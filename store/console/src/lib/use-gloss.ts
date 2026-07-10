/**
 * Under-message translation + transliteration state for the Assistant chat
 * (Settings → Translation). Extracted from InstanceDetail so the page owns chat
 * flow while this hook owns the learning display: config loading, the gloss
 * cache keyed by message content, seeding from server-embedded glosses, lazy
 * fill for uncached history, and the one-card fetch for fresh replies.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import type { Message, MessageGloss } from "./types";

/** Learning-display sizes (Settings → Translation → Text size). The gloss size is
 *  shared by the transliteration AND the translation — equally visible, color is
 *  the only differentiator. "medium" word size EQUALS the bubble's base text
 *  (text-sm) so glossed and plain messages read as one typeface. */
const SIZES: Record<string, { word: string; gloss: string }> = {
	small: { word: "text-[0.8rem]", gloss: "text-[0.7rem]" },
	medium: { word: "text-[0.875rem]", gloss: "text-[0.78rem]" },
	large: { word: "text-[1.1rem]", gloss: "text-[0.95rem]" },
};

interface TranslationConfigWire {
	enabled: boolean;
	target?: string;
	/** BCP-47 tag for the target — served by the API (single source of truth). */
	targetTag?: string;
	wordTap?: boolean;
	fontSize?: string;
}

export function useGloss(instanceId: string | undefined, tab: string, messages: Message[]) {
	const [enabled, setEnabled] = useState(false);
	const [target, setTarget] = useState("English");
	const [targetTag, setTargetTag] = useState("en-US");
	const [wordTap, setWordTap] = useState(true);
	const [fontSize, setFontSize] = useState("medium");
	const [translations, setTranslations] = useState<Record<string, MessageGloss>>({});
	const inFlight = useRef<Set<string>>(new Set());
	// Ref mirror so ref-stable callers (doSend) see the live value.
	const enabledRef = useRef(false);
	useEffect(() => { enabledRef.current = enabled; }, [enabled]);

	// Reset the cache only when switching instances (not tabs).
	useEffect(() => {
		setEnabled(false);
		setTranslations({});
		inFlight.current = new Set();
	}, [instanceId]);

	// (Re)load the config on every return to the chat tab: Settings is a sibling tab
	// on the SAME page (no remount), so enabling/changing Translation there must show
	// up here without a reload.
	useEffect(() => {
		if (!instanceId || tab !== "chat") return;
		(async () => {
			try {
				const d = await api<{ translation?: TranslationConfigWire }>(`/v1/instances/${instanceId}/translation`);
				setEnabled(d.translation?.enabled === true);
				setTarget(d.translation?.target || "English");
				setTargetTag(d.translation?.targetTag || "en-US");
				setWordTap(d.translation?.wordTap !== false);
				setFontSize(d.translation?.fontSize || "medium");
			} catch {}
		})();
	}, [instanceId, tab]);

	// Cached glosses arrive EMBEDDED in the messages payload — seed them so history
	// renders glossed in the same paint, with zero extra requests. Only genuinely
	// uncached messages hit /translate (newest first, so what you're reading fills in
	// first) — each is computed once EVER, then served embedded.
	useEffect(() => {
		if (!enabled || !instanceId) return;
		const seeded: Record<string, MessageGloss> = {};
		for (const m of messages) {
			if (m.role === "assistant" && m.gloss?.translation && !(m.content in translations)) {
				seeded[m.content] = m.gloss;
			}
		}
		if (Object.keys(seeded).length) setTranslations((t) => ({ ...seeded, ...t }));
		const pending = messages
			.filter((m) => m.role === "assistant" && m.content?.trim())
			.reverse()
			.filter((m) => !(m.content in translations) && !(m.content in seeded) && !inFlight.current.has(m.content));
		for (const m of pending) inFlight.current.add(m.content);
		(async () => {
			for (const m of pending) {
				try {
					const d = await api<MessageGloss>(`/v1/instances/${instanceId}/translate`, {
						method: "POST",
						body: JSON.stringify({ text: m.content }),
					});
					if (d.translation) setTranslations((t) => ({ ...t, [m.content]: d }));
				} catch {
					inFlight.current.delete(m.content); // retry on a later render
				}
			}
		})();
	}, [enabled, instanceId, messages]); // eslint-disable-line react-hooks/exhaustive-deps

	/** One-card rendering for a FRESH reply: fetch its gloss BEFORE the caller appends
	 *  the message (the thinking spinner covers the wait). Capped at 6s — a slow or
	 *  failed gloss never holds the reply hostage; it fills in lazily like history. */
	const glossReply = useCallback(async (text: string) => {
		if (!enabledRef.current || !instanceId || !text?.trim()) return;
		try {
			const gloss = await Promise.race([
				api<MessageGloss>(`/v1/instances/${instanceId}/translate`, {
					method: "POST",
					body: JSON.stringify({ text }),
				}),
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000)),
			]);
			if (gloss?.translation) {
				inFlight.current.add(text);
				setTranslations((t) => ({ ...t, [text]: gloss }));
			}
		} catch { /* lazy fill-in fallback */ }
	}, [instanceId]);

	return {
		enabled,
		target,
		targetTag,
		wordTap,
		sizes: SIZES[fontSize] || SIZES.medium,
		translations,
		glossReply,
	};
}
