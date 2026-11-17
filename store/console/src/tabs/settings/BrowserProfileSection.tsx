import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Button from "../../components/Button";
import Card from "../../components/Card";
import LoadFailed from "../../components/LoadFailed";
import type { BrowserSettingsView } from "../../lib/browserSettings";
import {
	CHOICE_ORDER, OWN_PROFILE_CAVEAT, choiceLabel, ownProfileBlock, selectedChoice, writesFor,
	type ProfileChoice, type ProfileInputs, type ResearchProfile,
} from "../../lib/browserProfileChoice";
import type { LocalBrowserConsentEntry, LocalBrowserConsentList, LocalBrowserSettingsResponse } from "../../lib/types";

/** What the loaded settings say, in the shape the choice logic reads. */
export function inputsFrom(browserProfile: ResearchProfile, view: BrowserSettingsView): ProfileInputs {
	return { browserProfile, instanceEngine: view.engine, instanceProfile: view.profile, agentEngine: view.agentDefaults.engine, agentProfile: view.agentDefaults.profile };
}

/**
 * The one browser-profile control (#1601): four choices, each launching exactly what its label says. `chosen` is the owner's draft
 * (null: nothing changed, so the choice that takes effect today is shown). `blocked` is the reason choice 3 cannot be used, or null.
 */
export function BrowserProfileChoices({ inputs, chosen, profileAllowed, saving, onChoose, onConsent }: {
	inputs: ProfileInputs;
	chosen: ProfileChoice | null;
	profileAllowed: boolean;
	saving?: boolean;
	onChoose: (choice: ProfileChoice) => void;
	onConsent: (allow: boolean) => void;
}) {
	const blocked = ownProfileBlock(inputs);
	// A blocked "own" is never shown as chosen: what takes effect is shown instead, so no managed profile is passed off as the owner's.
	const current = chosen && !(chosen === "own" && blocked) ? chosen : selectedChoice(inputs);
	return (
		<fieldset className="flex flex-col gap-2 text-sm" disabled={saving} data-testid="browser-profile-choices">
			<legend className="text-xs font-semibold mb-1">Browser profile</legend>
			{CHOICE_ORDER.map((choice) => {
				const disabled = choice === "own" && blocked !== null;
				return (
					<div key={choice}>
						<label className={`flex gap-2 items-start min-h-6 ${disabled ? "text-muted" : ""}`}>
							<input type="radio" name="browser-profile" className="mt-1" checked={current === choice} disabled={disabled} aria-describedby={choice === "own" ? "browser-profile-own-note" : undefined} onChange={() => onChoose(choice)} />
							<span>{choiceLabel(choice, inputs)}</span>
						</label>
						{choice === "own" && (
							<p id="browser-profile-own-note" className={`text-xs ml-6 ${blocked ? "text-warning" : "text-muted"}`} data-testid={blocked ? "own-profile-blocked" : "own-profile-caveat"}>
								{blocked ?? OWN_PROFILE_CAVEAT}
							</p>
						)}
						{choice === "own" && current === "own" && !blocked && (
							<label className="flex gap-2 items-center text-xs text-muted ml-6 mt-1 min-h-6">
								<input type="checkbox" checked={profileAllowed} onChange={(e) => onConsent(e.target.checked)} />
								I allow research in my signed-in profile (a run waits for this otherwise)
							</label>
						)}
					</div>
				);
			})}
		</fieldset>
	);
}

/** Settings → Browser: the profile choice, for agents that run local browser research. Saves both stores it spans, only the ones that change. */
export default function BrowserProfileSection({ instanceId }: { instanceId: string }) {
	const [view, setView] = useState<BrowserSettingsView | null>(null);
	const [browserProfile, setBrowserProfile] = useState<ResearchProfile>("isolated");
	const [consent, setConsent] = useState<LocalBrowserConsentEntry[]>([]);
	const [chosen, setChosen] = useState<ProfileChoice | null>(null);
	const [error, setError] = useState("");
	const [msg, setMsg] = useState("");
	const [saving, setSaving] = useState(false);

	const load = useCallback(async () => {
		try {
			const [v, s, c] = await Promise.all([
				api<BrowserSettingsView>(`/v1/instances/${instanceId}/browser-settings`),
				api<LocalBrowserSettingsResponse>(`/v1/instances/${instanceId}/local-browser/settings`),
				api<LocalBrowserConsentList>(`/v1/instances/${instanceId}/local-browser/consent`),
			]);
			setView(v);
			setBrowserProfile(s.settings.browserProfile ?? "isolated");
			setConsent(c.consent);
			setChosen(null);
			setError("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [instanceId]);
	useEffect(() => { void load(); }, [load]);

	if (error && !view) return <LoadFailed what="browser profile settings" detail={error} onRetry={load} />;
	if (!view) return null;
	const inputs = inputsFrom(browserProfile, view);
	const profileAllowed = consent.some((c) => c.scope === "signed_in_profile" && c.decision === "allow");

	const decide = async (allow: boolean) => {
		try {
			setConsent((await api<LocalBrowserConsentList>(`/v1/instances/${instanceId}/local-browser/consent`, { method: "PUT", body: JSON.stringify({ scope: "signed_in_profile", decision: allow ? "allow" : null }) })).consent);
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
	};
	const save = async () => {
		if (!chosen) return;
		const next = writesFor(chosen);
		setSaving(true);
		setMsg("");
		try {
			if (next.profile !== view.profile) setView(await api<BrowserSettingsView>(`/v1/instances/${instanceId}/browser-settings`, { method: "PUT", body: JSON.stringify({ profile: next.profile }) }));
			if (next.browserProfile !== browserProfile) {
				await api(`/v1/instances/${instanceId}/local-browser/settings`, { method: "PUT", body: JSON.stringify({ browserProfile: next.browserProfile === "default" ? "default" : null }) });
				setBrowserProfile(next.browserProfile);
			}
			setChosen(null);
			setMsg("Saved — applies on the next browser launch. Current tasks continue unchanged.");
		} catch (e) {
			// The first write may have landed: reload so the control shows what the saved settings now launch, not the draft.
			setMsg(e instanceof Error ? e.message : String(e));
			await load();
		}
		setSaving(false);
	};

	return (
		<Card className="mb-3 sm:mb-4" data-testid="browser-profile-settings">
			<h3 className="text-base font-bold mb-1">Browser profile</h3>
			<p className="text-sm text-muted mb-3">Which browser profile a run uses. Each choice launches exactly what it says. Changes apply on the next browser launch.</p>
			<BrowserProfileChoices inputs={inputs} chosen={chosen} profileAllowed={profileAllowed} saving={saving} onChoose={setChosen} onConsent={(allow) => void decide(allow)} />
			<div className="flex items-center gap-3 mt-3">
				<Button onClick={() => void save()} disabled={saving || !chosen}>{saving ? "Saving…" : "Save"}</Button>
				{msg && <p role="status" className="text-xs">{msg}</p>}
			</div>
		</Card>
	);
}
