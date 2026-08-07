import { useCallback, useEffect, useState } from "react";
import Page from "../components/Page";
import { api } from "@proagentstore/sdk/client";
import VoiceFields from "../components/VoiceFields";
import TranslationFields from "../components/TranslationFields";
import AccountConnections from "../components/AccountConnections";
import { machineTimeZone, setAccountTimeZone, timeZoneOptions, useAccountTimeZone } from "../lib/accountTimezone";

/** The current wall clock in a zone, or "" when this runtime cannot resolve it — never a throw. */
function nowIn(zone: string): string {
	try {
		return new Date().toLocaleString(undefined, { timeZone: zone, timeStyle: "short", dateStyle: "medium" });
	} catch {
		return "";
	}
}

/**
 * Your ACCOUNT: the things that are true of you rather than of any one agent (#211, #355).
 *
 * The page arrived as "how you speak, hear and read", and its subtitle promised that everything
 * on it "can be customised on its own Settings tab". That was already false for two of the four
 * sections when #355 was assessed — Timezone has no per-instance override at all (its own save
 * text says "every agent uses this") and Appearance is localStorage, per-browser, nothing to do
 * with agents. Connections are the least overridable thing yet: there is exactly one Gmail
 * account and no per-agent variant of it can exist.
 *
 * That matters more than a stale sentence usually would, because #355 moved connect/disconnect
 * HERE precisely so a destructive account-wide control would stop rendering under one agent's
 * name. Dropping it under a header promising per-agent customisation would have reproduced the
 * same misread one level up, with the destructive buttons on it. So the subtitle now states each
 * section's scope, and the page is the DEFINITION of account scope rather than a page that
 * happens to hold some of it.
 *
 * Every section here is deliberately un-overridable except voice and translation, which carry the
 * explicit "Use my defaults / Customise for this agent" control (#211) on an agent's Settings
 * tab. Connections get no such control and must never grow one: it would promise a per-agent
 * scoping that cannot exist.
 *
 * Split out of the instance Settings tab, which mixed three scopes: what an agent IS (its repo,
 * its runner, its triggers), how the OWNER likes things (voice, translation), and the danger zone.
 * Only the first and third are properties of an agent. Configuring your own speech-recognition
 * preference once per agent was the tell — and a new subscription seeded none of it, so every agent
 * you added made you re-tune from platform defaults.
 *
 * Split out of Profile too, which is identity and money: account, profile, candidate profile, API
 * token, billing, keys. Appearance moved here because it is the same kind of thing as the rest of
 * this page — a preference, not an identity.
 *
 * An agent can still differ: its Settings tab offers "Customise for this agent", which writes a
 * per-instance override. This page is what that override falls back to.
 */
export default function Preferences() {
	const [voice, setVoice] = useState<Record<string, unknown>>({});
	const [translation, setTranslation] = useState<Record<string, unknown>>({});
	const [languages, setLanguages] = useState<Array<{ name: string; tag: string }>>([]);
	const [hasOpenAiKey, setHasOpenAiKey] = useState<boolean | null>(null);
	const [loaded, setLoaded] = useState(false);

	const [textScale, setTextScaleState] = useState(() => {
		try {
			return Number.parseFloat(localStorage.getItem("pags:textScale") || "1") || 1;
		} catch {
			return 1;
		}
	});
	const setTextScale = (s: number) => {
		setTextScaleState(s);
		localStorage.setItem("pags:textScale", String(s));
		// "" (not "100%") at 1× so the stylesheet default wins again — matching what Profile did.
		document.documentElement.style.fontSize = s === 1 ? "" : `${s * 100}%`;
	};

	useEffect(() => {
		(async () => {
			try {
				const d = await api<{
					preferences?: { voice?: Record<string, unknown>; translation?: Record<string, unknown> };
					languages?: Array<{ name: string; tag: string }>;
				}>("/v1/preferences");
				setVoice(d.preferences?.voice || {});
				setTranslation(d.preferences?.translation || {});
				setLanguages(d.languages || []);
			} catch {
				// A failed read must still render the controls at platform defaults — an empty page
				// with no explanation is worse than editable defaults.
			}
			setLoaded(true);
		})();
		api<{ providers?: Record<string, boolean> }>("/v1/keys/status")
			.then((d) => setHasOpenAiKey(!!d.providers?.openai))
			.catch(() => setHasOpenAiKey(null));
	}, []);

	/** Section-level PATCH: sending only `voice` leaves stored translation untouched, and vice versa. */
	const saveVoice = useCallback(async (patch: Record<string, unknown>) => {
		const next = { ...voice, ...patch };
		setVoice(next);
		const d = await api<{ preferences?: { voice?: Record<string, unknown> } }>("/v1/preferences", {
			method: "PUT",
			body: JSON.stringify({ voice: next }),
		});
		if (d.preferences?.voice) setVoice(d.preferences.voice);
	}, [voice]);

	const saveTranslation = useCallback(async (next: Record<string, unknown>) => {
		setTranslation(next);
		await api("/v1/preferences", { method: "PUT", body: JSON.stringify({ translation: next }) });
	}, []);

	/**
	 * The zone every agent narrates in, and every timestamp here renders in (#329/#345).
	 *
	 * It is seeded from this machine on first load, so this control is normally already correct and
	 * exists for the case the seed cannot serve: an owner whose machine is not where they live, or
	 * who travels and wants their agents to keep speaking home time. `""` sends `null`, which clears
	 * it back to UNSET — a state the user must be able to return to, because it is not "UTC", it is
	 * "you were never told", and it is what makes an agent say UTC out loud instead of guessing.
	 */
	const timezone = useAccountTimeZone();
	const [tzMsg, setTzMsg] = useState("");
	const saveTimezone = useCallback(async (next: string) => {
		const previous = timezone;
		setAccountTimeZone(next || undefined);
		setTzMsg("Saved — every agent uses this");
		try {
			await api("/v1/preferences", { method: "PUT", body: JSON.stringify({ timezone: next || null }) });
		} catch {
			// The route REJECTS a zone it cannot resolve rather than coercing it (#329), so a failure
			// here means nothing was stored — put the control back rather than showing a save that
			// did not happen.
			setAccountTimeZone(previous);
			setTzMsg("Could not save that timezone.");
		}
	}, [timezone]);

	return (
		<Page width={960}>
			<h2 className="text-xl font-bold mb-1">Preferences</h2>
			<p className="text-sm text-muted mb-5">
				Your account — connections, timezone, and how you speak, hear and read.{" "}
				<b>Connections and timezone apply to every agent and cannot be overridden.</b> Voice and
				translation are defaults any agent can override on its own Settings tab. Appearance is
				this browser only.
			</p>

			<AccountConnections />

			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-2">Appearance</h3>
				<div className="flex justify-between items-center py-2.5 text-sm">
					<span className="text-muted font-medium">Text size</span>
					<div className="inline-flex border border-line rounded-lg overflow-hidden">
						{[{ s: 0.9, l: "A-" }, { s: 1, l: "A" }, { s: 1.15, l: "A+" }, { s: 1.3, l: "A++" }].map(({ s, l }) => (
							<button
								key={s}
								type="button"
								onClick={() => setTextScale(s)}
								className={`px-2.5 py-1 text-xs font-bold ${textScale === s ? "bg-panel-hover text-ink" : "text-muted"}`}
							>
								{l}
							</button>
						))}
					</div>
				</div>
			</div>

			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-1">Timezone</h3>
				<p className="text-xs text-muted mb-2">
					What "today", "this morning" and "overnight" mean when an agent talks to you, and the
					clock every timestamp is shown in. Leave it unset and agents say UTC and say so.
				</p>
				<div className="flex justify-between items-center py-2.5 text-sm gap-3">
					<span className="text-muted font-medium">Your timezone</span>
					<select
						aria-label="Your timezone"
						value={timezone || ""}
						onChange={(e) => void saveTimezone(e.target.value)}
						className="text-sm bg-paper border border-line rounded-lg px-3 py-2 max-w-[60%]"
					>
						<option value="">Not set — agents will say UTC</option>
						{timeZoneOptions(timezone).map((tz) => (
							<option key={tz} value={tz}>
								{tz}
								{tz === machineTimeZone() ? " (this machine)" : ""}
							</option>
						))}
					</select>
				</div>
				{/* The confirmation that a zone name is the RIGHT zone name: nobody knows what
				    "America/Kentucky/Monticello" is, everybody knows whether it is 8am there. */}
				{timezone && nowIn(timezone) && (
					<p className="text-xs text-muted">
						It is <b>{nowIn(timezone)}</b> there.
					</p>
				)}
				{tzMsg && <p className="text-xs text-muted mt-1">{tzMsg}</p>}
			</div>

			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-2">Voice</h3>
				{loaded && <VoiceFields value={voice} onPatch={saveVoice} hasOpenAiKey={hasOpenAiKey} savedNote="Saved — applies to every agent" />}
			</div>

			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-1">Translation</h3>
				{loaded && <TranslationFields value={translation} onSave={saveTranslation} languages={languages} />}
			</div>
		</Page>
	);
}
