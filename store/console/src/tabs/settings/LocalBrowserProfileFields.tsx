import { Link } from "react-router-dom";
import type { BrowserSettingsView } from "../../lib/browserSettings";

type Launch = Pick<BrowserSettingsView, "launchPath" | "sources">;

/**
 * Why the owner's own profile is not used (#1603), or null. The server decides the launch path; the
 * wording only depends on whether the owner set the engine/profile or the agent's defaults did.
 */
export function ownProfileNotice(launch: Launch | null): string | null {
	if (launch?.launchPath !== "managed") return null;
	const ownerSet = launch.sources.engine === "instance" || launch.sources.profile === "instance";
	return `Your own profile is not used while ${ownerSet ? "a browser or profile is set in Browser settings" : "this agent's default browser or profile applies"}`;
}

/** Settings → Local browser research → Browser: the profile choice, told truthfully. `launch` is null while loading or failed. */
export default function LocalBrowserProfileFields({ instanceId, browserProfile, profileAllowed, launch, onProfile, onConsent }: {
	instanceId: string;
	browserProfile: string;
	profileAllowed: boolean;
	launch: Launch | null;
	onProfile: (value: "isolated" | "default") => void;
	onConsent: (allow: boolean) => void;
}) {
	const notice = ownProfileNotice(launch);
	return (
		<fieldset className="mb-3">
			<legend className="text-xs font-semibold mb-1">Browser</legend>
			<div className="flex flex-col gap-1 text-sm">
				<label className="flex gap-2 items-center">
					<input type="radio" checked={browserProfile === "isolated"} onChange={() => onProfile("isolated")} /> A fresh browser with no sign-ins
				</label>
				<label className="flex gap-2 items-center">
					<input type="radio" checked={browserProfile === "default"} onChange={() => onProfile("default")} /> My own browser profile, with my sign-ins
				</label>
				{notice && (
					<p className="text-xs text-warning ml-5" data-testid="own-profile-notice">
						{notice} ·{" "}
						<Link to={`/instances/${encodeURIComponent(instanceId)}/settings`} className="inline-flex items-center min-h-6 underline">
							Open Browser settings
						</Link>
					</p>
				)}
				{browserProfile === "default" && !notice && (
					<label className="flex gap-2 items-center text-xs text-muted ml-5">
						<input type="checkbox" checked={profileAllowed} onChange={(e) => onConsent(e.target.checked)} />
						I allow research in my signed-in profile (a run waits for this otherwise)
					</label>
				)}
			</div>
		</fieldset>
	);
}
