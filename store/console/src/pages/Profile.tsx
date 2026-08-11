import { useState, useEffect, useCallback } from "react";
import Button from "../components/Button";
import Page from "../components/Page";
import LoadFailed from "../components/LoadFailed";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/AuthContext";
import { api, getToken } from "@proagentstore/sdk/client";

interface ProfileField {
	key: string;
	label: string;
	group?: string;
	private?: boolean;
}

interface Provider {
	id: string;
	name: string;
	hasKey: boolean;
}

export default function Profile() {
	const { user, signOut } = useAuth();
	const navigate = useNavigate();
	const token = getToken();

	// Profile edit
	const [displayName, setDisplayName] = useState("");
	const [bio, setBio] = useState("");
	const [website, setWebsite] = useState("");
	const [twitter, setTwitter] = useState("");
	const [slack, setSlack] = useState("");

	// Profile details (personal + job-application fields)
	const [cpFields, setCpFields] = useState<ProfileField[]>([]);
	const [cpValues, setCpValues] = useState<Record<string, string>>({});
	const [cpStatus, setCpStatus] = useState("");

	// Does this user run an apply-surface agent? Job-application fields are shown only then
	// (#222) — the same capability gate the instance UI already uses, applied at user level.
	const [hasApplyAgent, setHasApplyAgent] = useState(false);

	// API keys
	const [providers, setProviders] = useState<Provider[]>([]);
	const [keysLoading, setKeysLoading] = useState(true);

	// Token
	const [tokenVisible, setTokenVisible] = useState(false);

	useEffect(() => {
		if (!user) return;
		setDisplayName(user.display_name || user.login || "");
		setBio(user.bio || "");
		setWebsite(user.website || "");
		setTwitter(user.twitter || "");
	}, [user]);

	// Load profile details
	useEffect(() => {
		(async () => {
			try {
				const d = await api<{ fields: ProfileField[]; profile: Record<string, string> }>("/v1/profile");
				setCpFields(d.fields || []);
				setCpValues(d.profile || {});
			} catch {
				// IGNORABLE, and deliberately so. `cpFields` drives whether the Candidate Profile
				// section renders AT ALL, so a failed read hides the section rather than showing an
				// empty version of it — there is no false "you have no profile" state to correct,
				// and no Save to arm, because the form itself is what did not render. The failure
				// is already in the durable log via `api()`. Adding an error card here would put a
				// job-application widget on the page of every user who has no apply agent, which
				// the surrounding gate exists to prevent.
			}
		})();
	}, []);

	// Resolve the apply gate from the instances the user actually has. Fails CLOSED: if the
	// call errors we show fewer fields, never job-application PII to someone who has no use
	// for it.
	useEffect(() => {
		(async () => {
			try {
				const d = await api<{ instances?: Array<{ capabilities?: { surfaces?: string[] } }> }>("/v1/instances/my/instances");
				setHasApplyAgent((d.instances || []).some(i => i.capabilities?.surfaces?.includes("apply")));
			} catch { setHasApplyAgent(false); }
		})();
	}, []);

	// Load API keys
	// A failed key-status read rendered every provider as "no key stored" (#291) — which is not a
	// blank, it is the state that prompts the user to paste a key they already have. Worse, this is
	// the page they land on when BYOK is not working, so the wrong answer arrives exactly when it
	// will be believed.
	const [keysErr, setKeysErr] = useState("");
	const loadKeys = useCallback(async () => {
		setKeysLoading(true);
		try {
			const d = await api<{ providers: Provider[] }>("/v1/keys/status");
			setProviders(d.providers || []);
			setKeysErr("");
		} catch (e) {
			setKeysErr(e instanceof Error ? e.message : String(e));
		}
		setKeysLoading(false);
	}, []);

	useEffect(() => { loadKeys(); }, [loadKeys]);

	const saveProfile = async () => {
		try {
			const updates: Record<string, string> = { display_name: displayName, bio, website, twitter };
			if (slack && !slack.startsWith("(")) updates.slack_webhook = slack;
			await api("/v1/auth/me", { method: "PUT", body: JSON.stringify(updates) });
			alert("Profile saved!");
		} catch (e) { alert(e instanceof Error ? e.message : String(e)); }
	};

	const saveProfileDetails = async () => {
		try {
			await api("/v1/profile", { method: "PUT", body: JSON.stringify(cpValues) });
			setCpStatus("Saved");
			setTimeout(() => setCpStatus(""), 2500);
		} catch { setCpStatus("Save failed"); }
	};

	const addKey = async (providerId: string, providerName: string) => {
		let accountId: string | null = null;
		if (providerId === "cloudflare") {
			accountId = prompt("Cloudflare account ID:");
			if (!accountId) return;
		}
		const key = prompt(`${providerName} API key:`);
		if (!key) return;
		try {
			await api(`/v1/keys/${providerId}`, { method: "PUT", body: JSON.stringify({ key, accountId }) });
			loadKeys();
		} catch (e) { alert(e instanceof Error ? e.message : String(e)); }
	};

	const removeKey = async (providerId: string, providerName: string) => {
		if (!confirm(`Remove ${providerName} key?`)) return;
		try {
			await api(`/v1/keys/${providerId}`, { method: "DELETE" });
			loadKeys();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	if (!user) return null;

	// Anything ungrouped falls in with personal details rather than disappearing. The old
	// `voice` group no longer exists server-side (#222, migration 0075) — control words live
	// in Preferences → Voice, the only place that was ever actually read.
	const personalFields = cpFields.filter(f => f.group !== "preferences" && f.group !== "job");
	const jobFields = cpFields.filter(f => f.group === "job");
	const prefFields = cpFields.filter(f => f.group === "preferences");

	return (
		<Page>
			<div className="flex justify-between items-center mb-6">
				<h1 className="font-display text-xl font-bold">Profile</h1>
				<Button size="lg" onClick={() => navigate(-1)}>&larr; Back</Button>
			</div>

			<div className="bg-panel border border-line rounded-xl p-3 sm:p-6">
				{/* Header */}
				<div className="flex items-center gap-5 mb-6 min-w-0">
					<img src={user.avatar} alt="" width={72} height={72} className="w-[72px] h-[72px] rounded-full border-[3px] border-line" />
					<div className="min-w-0 flex-1">
						<div className="font-display text-xl font-bold [overflow-wrap:anywhere]">{user.display_name || user.login}</div>
						<div className="text-sm text-muted [overflow-wrap:anywhere]">@{user.login}</div>
						{/* flex-wrap, because the parent's min-w-0 lets the COLUMN shrink but a nowrap
						    row inside it cannot — it just pushes past the edge. All three real roles
						    still fit at 320px today, so this is the fragility rather than a live
						    overflow; VoiceFields' chip rows already wrap for the same reason (#333). */}
						{user.roles && (
							<div className="flex flex-wrap gap-1.5 mt-1.5">
								{user.roles.map(r => (
									<span key={r} className={`text-2xs px-2 py-0.5 rounded-full font-semibold ${r === "admin" ? "bg-danger-soft text-danger" : r === "creator" ? "bg-accent-soft text-purple-400" : "bg-info-soft text-info"}`}>{r}</span>
								))}
							</div>
						)}
					</div>
				</div>

				{/* Account */}
				<div className="mb-6">
					<h3 className="text-base font-semibold mb-3">Account</h3>
					<div className="flex justify-between items-center gap-3 py-2.5 border-b border-line text-sm min-w-0">
						<span className="text-muted font-medium">User ID</span>
						<span className="font-mono text-sm truncate max-w-[200px] min-w-0 text-right">{user.id}</span>
					</div>
					<div className="flex justify-between items-center gap-3 py-2.5 border-b border-line text-sm min-w-0">
						<span className="text-muted font-medium">GitHub</span>
						<a href={`https://github.com/${user.login}`} target="_blank" rel="noopener" className="text-accent min-w-0 text-right [overflow-wrap:anywhere]">{user.login}</a>
					</div>
				</div>

				{/* Edit Profile */}
				<div className="mb-6">
					<h3 className="text-base font-semibold mb-3">Edit Profile</h3>
					<div className="flex flex-col gap-2">
						<label className="flex flex-col gap-1">
							<span className="text-xs text-muted font-semibold">Display Name</span>
							<input value={displayName} onChange={e => setDisplayName(e.target.value)} />
						</label>
						<label className="flex flex-col gap-1">
							<span className="text-xs text-muted font-semibold">Bio</span>
							<input value={bio} onChange={e => setBio(e.target.value)} />
						</label>
						<div className="grid grid-cols-2 gap-2 max-sm:grid-cols-1">
							<label className="flex flex-col gap-1">
								<span className="text-xs text-muted font-semibold">Website</span>
								<input value={website} onChange={e => setWebsite(e.target.value)} placeholder="https://..." />
							</label>
							<label className="flex flex-col gap-1">
								<span className="text-xs text-muted font-semibold">Twitter/X</span>
								<input value={twitter} onChange={e => setTwitter(e.target.value)} placeholder="username" />
							</label>
						</div>
						<label className="flex flex-col gap-1">
							<span className="text-xs text-muted font-semibold">Slack Webhook</span>
							<input value={slack} onChange={e => setSlack(e.target.value)} placeholder="https://hooks.slack.com/..." />
						</label>
						<Button variant="primary" size="lg" onClick={saveProfile} className="self-start">Save Profile</Button>
					</div>
				</div>

				{/* Personal details — general contact info any agent may need to fill a form.
				    Shown to everyone; the job-specific fields below are gated separately (#222). */}
				{personalFields.length > 0 && (
					<div className="mb-6">
						<h3 className="text-base font-semibold mb-1">Personal details</h3>
						<p className="text-sm text-muted mb-3">Structured info your agents use to fill forms. Private — never shown publicly.</p>
						<div className="grid grid-cols-2 gap-2 max-sm:grid-cols-1">
							{personalFields.map(f => (
								<label key={f.key} className="flex flex-col gap-1">
									<span className="text-xs text-muted font-semibold">{f.label}{f.private ? <span className="text-muted-soft"> · private</span> : ""}</span>
									<input value={cpValues[f.key] || ""} onChange={e => setCpValues(p => ({ ...p, [f.key]: e.target.value }))} />
								</label>
							))}
						</div>
						{/* Job-application fields, only for a user who actually runs an apply agent.
						    Previously everyone saw work authorization, salary expectation and target
						    roles regardless of what their agents do — gated on whether the schema
						    returned fields rather than on having any use for them. */}
						{hasApplyAgent && (jobFields.length > 0 || prefFields.length > 0) && (
							<>
								<div className="mt-4 font-bold text-sm">Job application details <span className="font-normal text-muted text-xs">— used by your job-application agent</span></div>
								<div className="grid grid-cols-2 gap-2 mt-1 max-sm:grid-cols-1">
									{[...jobFields, ...prefFields].map(f => (
										<label key={f.key} className="flex flex-col gap-1">
											<span className="text-xs text-muted font-semibold">{f.label}{f.private ? <span className="text-muted-soft"> · private</span> : ""}</span>
											<input value={cpValues[f.key] || ""} onChange={e => setCpValues(p => ({ ...p, [f.key]: e.target.value }))} />
										</label>
									))}
								</div>
							</>
						)}
						<div className="flex items-center gap-2 mt-3">
							<Button variant="primary" size="lg" onClick={saveProfileDetails}>Save Profile</Button>
							{cpStatus && <span className="text-xs text-muted">{cpStatus}</span>}
						</div>
						{/* Voice commands used to live here too, writing a global setting through a
						    different endpoint than Preferences — and losing. One home now. */}
						<p className="text-2xs text-muted-soft mt-3">
							Looking for hands-free voice commands? They live in <a href="/preferences" className="text-accent">Preferences → Voice</a>.
						</p>
					</div>
				)}

				{/* API Token */}
				<div className="mb-6">
					<h3 className="text-base font-semibold mb-3">API Token</h3>
					{/* Wraps rather than pushes (#235): a revealed token is long, and the row is one
					    fixed-width span plus two buttons. `min-w-0` is what lets the span shrink at
					    all — without it a flex child refuses to go below its content width, and the
					    row grows the card instead of truncating the string. */}
					<div className="flex items-center gap-2 flex-wrap">
						<span className="bg-paper border border-line rounded-md px-2.5 py-1.5 font-mono text-xs text-muted max-w-[220px] min-w-0 flex-1 truncate">
							{tokenVisible && token ? token : token ? `${token.slice(0, 12)}...` : "Not signed in"}
						</span>
						<Button size="sm" onClick={() => { if (token) navigator.clipboard.writeText(token); }}>Copy</Button>
						<Button size="sm" onClick={() => setTokenVisible(!tokenVisible)}>{tokenVisible ? "Hide" : "Show"}</Button>
					</div>
				</div>

				{/* Billing */}
				<div className="mb-6">
					<h3 className="text-base font-semibold mb-3">Billing</h3>
					<div className="bg-paper border border-line rounded-lg p-3">
						<span className="text-sm text-muted">
							ProAgentStore billing is not enabled yet. Platform access is open during preview.
						</span>
					</div>
				</div>

				{/* API Keys */}
				<div className="mb-6">
					<h3 className="text-base font-semibold mb-3">API Keys</h3>
					<p className="text-sm text-muted mb-3">Store your AI provider keys. Encrypted with AES-256-GCM.</p>
					{keysErr ? (
						<LoadFailed what="your API keys" detail={keysErr} onRetry={loadKeys} testId="keys-load-failed" compact />
					) : keysLoading ? <p className="text-sm text-muted">Loading keys...</p> : (
						<div className="flex flex-col gap-2">
							{providers.map(p => (
								<div key={p.id} className="flex items-center gap-2 sm:gap-3 p-2.5 bg-paper border border-line rounded-lg">
									{/* A provider name is the only elastic part of this row; everything else is
									    a fixed control. Let it truncate instead of widening the card. */}
									<span className="text-sm font-medium flex-1 min-w-0 truncate">{p.name}</span>
									<span className={`text-xs ${p.hasKey ? "text-success" : "text-muted-soft"}`}>{p.hasKey ? "Stored" : "Not set"}</span>
									{p.hasKey ? (
										<Button size="sm" variant="danger" onClick={() => removeKey(p.id, p.name)}>Remove</Button>
									) : (
										<Button size="sm" variant="primary" onClick={() => addKey(p.id, p.name)}>Add Key</Button>
									)}
								</div>
							))}
						</div>
					)}
				</div>

				{/* Sign out */}
				<div className="mt-4">
					<Button variant="danger" size="lg" onClick={() => { signOut(); navigate("/"); }}>Sign Out</Button>
				</div>
			</div>
		</Page>
	);
}
