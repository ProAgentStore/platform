// Visual identity for agents and their instances.
//
// The instances list was text-only: same font, same weight, no mark, and a constant "subscribed"
// badge on every card. Three Repo Coders — one per repo — were literally indistinguishable, and
// the only way to tell them apart was to read the title carefully. An agent you cannot recognise
// at a glance is one you have to think about every time.
//
// Two separate jobs, deliberately not conflated:
//   • the AGENT's mark says WHAT IT DOES  — shared by every instance of it
//   • the INSTANCE's tint says WHICH ONE  — different for each, so siblings never collide
//
// Pure and tested: colour picked from a hash must be stable forever (an avatar that changes on
// reload is worse than no avatar) and must never collide for siblings of the same agent.

export interface IdentityInput {
	id: string;
	/** Instance display name when renamed, else the agent's name. */
	name?: string;
	/** The agent's name when the instance was renamed — the "what it is" behind "which one". */
	agentName?: string;
	slug?: string;
	category?: string;
	icon?: string;
	icon_bg?: string;
	capabilities?: { surfaces?: string[]; runtime?: string | null } | null;
}

export interface Identity {
	/** Emoji shown in the avatar tile. */
	emoji: string;
	/** Tile background — the instance's own tint. */
	bg: string;
	/** Two-letter fallback when there is no emoji at all. */
	initials: string;
	/** "Repo Coder" under "FAS platform" — null when they are the same thing. */
	subtitle: string | null;
}

/**
 * Tints for instance tiles. Distinct hues rather than shades so two siblings are told apart at a
 * glance, not by comparing. Chosen to sit on both light and dark panels.
 */
const TINTS = [
	"#7c3aed", // violet
	"#0ea5e9", // sky
	"#10b981", // emerald
	"#f59e0b", // amber
	"#ef4444", // red
	"#ec4899", // pink
	"#14b8a6", // teal
	"#8b5cf6", // purple
	"#f97316", // orange
	"#3b82f6", // blue
];

/** Emoji by what the agent DOES, used when it declares none of its own. A generic robot for
 *  everything would defeat the purpose — the mark has to carry meaning. */
const BY_SURFACE: Record<string, string> = {
	coding: "⌨️",
	repo: "🔍",
	apply: "📄",
	insurance: "🛡️",
};
const BY_CATEGORY: Record<string, string> = {
	code: "💻",
	sales: "📈",
	productivity: "⚡",
	creative: "🎨",
	education: "🎓",
	research: "🔬",
	social: "💬",
	data: "📊",
	testing: "🧪",
	chat: "💬",
	general: "🤖",
	"developer-tools": "🛠️",
};

/** FNV-1a — small, stable, and dependency-free. Must not change: a tile that moves colour
 *  between releases breaks the recognition this whole module exists to create. */
function hash(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/** Two letters from a name, skipping noise words so "The Daily Grind" reads DG not TD. */
export function initialsOf(name: string): string {
	const words = (name || "")
		.split(/[\s\-_/]+/)
		.filter((w) => w && !/^(the|a|an|of|and|my)$/i.test(w));
	if (!words.length) return "AI";
	if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
	return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Resolve an instance's visual identity.
 *
 * The agent's own `icon`/`icon_bg` win when set — a creator's chosen mark is intent, not a
 * default to be overridden. The tint falls back to a hash of the INSTANCE id (not the agent's),
 * which is what makes siblings differ.
 */
export function identityFor(input: IdentityInput): Identity {
	const surfaces = input.capabilities?.surfaces ?? [];
	const emoji =
		(input.icon || "").trim() ||
		BY_SURFACE[surfaces[0] ?? ""] ||
		BY_CATEGORY[(input.category || "").toLowerCase()] ||
		"🤖";

	// A creator-set colour is honoured — EXCEPT the legacy default that every seeded agent
	// shares, which is the reason the page looked uniform in the first place.
	const declared = (input.icon_bg || "").trim();
	const bg = declared && declared.toLowerCase() !== "#7c3aed" ? declared : TINTS[hash(input.id) % TINTS.length];

	const name = input.name || input.agentName || input.slug || "Agent";
	// Only show the agent name when it differs — "Repo Coder / Repo Coder" is noise.
	const subtitle = input.agentName && input.agentName !== input.name ? input.agentName : null;

	return { emoji, bg, initials: initialsOf(name), subtitle };
}

/**
 * Short badges describing what the instance can do — replacing a constant "subscribed" that
 * appeared on every card and therefore distinguished nothing.
 */
export function capabilityBadges(input: IdentityInput): string[] {
	const out: string[] = [];
	const caps = input.capabilities;
	for (const s of caps?.surfaces ?? []) out.push(s);
	if (caps?.runtime) out.push("needs runner");
	return out.slice(0, 3);
}
