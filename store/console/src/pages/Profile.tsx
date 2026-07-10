import { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/AuthContext";
import { api, getToken } from "@proagentstore/sdk/client";

interface BillingStatus {
	active: boolean;
	status: string;
	expiresAt: string | null;
	hasBillingAccount: boolean;
	pro: boolean;
	enforced: boolean;
}

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

	// Candidate profile
	const [cpFields, setCpFields] = useState<ProfileField[]>([]);
	const [cpValues, setCpValues] = useState<Record<string, string>>({});
	const [cpStatus, setCpStatus] = useState("");

	// API keys
	const [providers, setProviders] = useState<Provider[]>([]);
	const [keysLoading, setKeysLoading] = useState(true);

	// Token
	const [tokenVisible, setTokenVisible] = useState(false);

	// Billing (the $9/mo Pro subscription)
	const [searchParams, setSearchParams] = useSearchParams();
	const [billing, setBilling] = useState<BillingStatus | null>(null);
	const [billingMsg, setBillingMsg] = useState("");
	const [billingBusy, setBillingBusy] = useState(false);
	const loadBilling = useCallback(async () => {
		try {
			const d = await api<BillingStatus>("/v1/billing/status");
			setBilling(d);
			return d;
		} catch { return null; }
	}, []);
	useEffect(() => { loadBilling(); }, [loadBilling]);
	// Returning from Stripe Checkout: the webhook can lag the redirect by a second
	// or two — re-poll a few times so the badge flips without a manual refresh.
	useEffect(() => {
		const b = searchParams.get("billing");
		if (!b) return;
		if (b === "success") {
			setBillingMsg("Payment received — activating your Pro subscription…");
			let tries = 0;
			const tick = async () => {
				const d = await loadBilling();
				tries++;
				if (d?.pro) { setBillingMsg("You're on Pro. Welcome aboard! 🎉"); return; }
				if (tries < 6) setTimeout(tick, 2000);
				else setBillingMsg("Payment received — status will update shortly.");
			};
			tick();
		} else if (b === "cancelled") {
			setBillingMsg("Checkout cancelled — no charge was made.");
		}
		searchParams.delete("billing");
		setSearchParams(searchParams, { replace: true });
	}, []); // eslint-disable-line react-hooks/exhaustive-deps

	const openCheckout = async () => {
		setBillingBusy(true);
		try {
			const d = await api<{ url: string }>("/v1/billing/checkout", { method: "POST" });
			window.location.href = d.url;
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
			setBillingBusy(false);
		}
	};
	const openPortal = async () => {
		setBillingBusy(true);
		try {
			const d = await api<{ url: string }>("/v1/billing/portal", { method: "POST" });
			window.location.href = d.url;
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
			setBillingBusy(false);
		}
	};

	// Text scale
	const [textScale, setTextScaleState] = useState(() => {
		try { return parseFloat(localStorage.getItem("pags:textScale") || "1") || 1; } catch { return 1; }
	});

	useEffect(() => {
		if (!user) return;
		setDisplayName(user.display_name || user.login || "");
		setBio(user.bio || "");
		setWebsite(user.website || "");
		setTwitter(user.twitter || "");
	}, [user]);

	// Load candidate profile
	useEffect(() => {
		(async () => {
			try {
				const d = await api<{ fields: ProfileField[]; profile: Record<string, string> }>("/v1/profile");
				setCpFields(d.fields || []);
				setCpValues(d.profile || {});
			} catch {}
		})();
	}, []);

	// Load API keys
	const loadKeys = useCallback(async () => {
		setKeysLoading(true);
		try {
			const d = await api<{ providers: Provider[] }>("/v1/keys/status");
			setProviders(d.providers || []);
		} catch {}
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

	const saveCandidateProfile = async () => {
		try {
			await api("/v1/profile", { method: "PUT", body: JSON.stringify(cpValues) });
			setCpStatus("Saved");
			setTimeout(() => setCpStatus(""), 2500);
		} catch { setCpStatus("Save failed"); }
	};

	const setTextScale = (s: number) => {
		setTextScaleState(s);
		localStorage.setItem("pags:textScale", String(s));
		document.documentElement.style.fontSize = s === 1 ? "" : `${s * 100}%`;
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

	const identityFields = cpFields.filter(f => f.group !== "preferences");
	const prefFields = cpFields.filter(f => f.group === "preferences");

	return (
		<div className="max-w-[960px] mx-auto px-3 py-3 sm:px-6 sm:py-5">
			<div className="flex justify-between items-center mb-6">
				<h1 className="font-display text-xl font-bold">Profile</h1>
				<button type="button" onClick={() => navigate(-1)} className="text-sm px-3 py-1.5 rounded-xl border border-line text-muted hover:border-accent hover:text-accent font-semibold">&larr; Back</button>
			</div>

			<div className="bg-panel border border-line rounded-xl p-3 sm:p-6">
				{/* Header */}
				<div className="flex items-center gap-5 mb-6">
					<img src={user.avatar} alt="" className="w-[72px] h-[72px] rounded-full border-[3px] border-line" />
					<div>
						<div className="font-display text-xl font-bold">{user.display_name || user.login}</div>
						<div className="text-sm text-muted">@{user.login}</div>
						{user.roles && (
							<div className="flex gap-1.5 mt-1.5">
								{user.roles.map(r => (
									<span key={r} className={`text-[0.7rem] px-2 py-0.5 rounded-full font-semibold ${r === "admin" ? "bg-red/15 text-red" : r === "creator" ? "bg-accent/15 text-purple-400" : "bg-blue/15 text-blue"}`}>{r}</span>
								))}
							</div>
						)}
					</div>
				</div>

				{/* Account */}
				<div className="mb-6">
					<h3 className="text-[0.95rem] font-semibold mb-3">Account</h3>
					<div className="flex justify-between items-center py-2.5 border-b border-line text-sm">
						<span className="text-muted font-medium">User ID</span>
						<span className="font-mono text-sm truncate max-w-[200px]">{user.id}</span>
					</div>
					<div className="flex justify-between items-center py-2.5 border-b border-line text-sm">
						<span className="text-muted font-medium">GitHub</span>
						<a href={`https://github.com/${user.login}`} target="_blank" rel="noopener" className="text-accent">{user.login}</a>
					</div>
				</div>

				{/* Appearance */}
				<div className="mb-6">
					<h3 className="text-[0.95rem] font-semibold mb-3">Appearance</h3>
					<div className="flex justify-between items-center py-2.5 border-b border-line text-sm">
						<span className="text-muted font-medium">Text size</span>
						<div className="inline-flex border border-line rounded-lg overflow-hidden">
							{[{ s: 0.9, l: "A-" }, { s: 1, l: "A" }, { s: 1.15, l: "A+" }, { s: 1.3, l: "A++" }].map(({ s, l }) => (
								<button key={s} type="button" onClick={() => setTextScale(s)}
									className={`px-2.5 py-1 text-xs font-bold ${textScale === s ? "bg-panel-hover text-ink" : "text-muted"}`}
								>{l}</button>
							))}
						</div>
					</div>
				</div>

				{/* Edit Profile */}
				<div className="mb-6">
					<h3 className="text-[0.95rem] font-semibold mb-3">Edit Profile</h3>
					<div className="flex flex-col gap-2">
						<div><label className="text-xs text-muted font-semibold">Display Name</label><input value={displayName} onChange={e => setDisplayName(e.target.value)} /></div>
						<div><label className="text-xs text-muted font-semibold">Bio</label><input value={bio} onChange={e => setBio(e.target.value)} /></div>
						<div className="grid grid-cols-2 gap-2 max-sm:grid-cols-1">
							<div><label className="text-xs text-muted font-semibold">Website</label><input value={website} onChange={e => setWebsite(e.target.value)} placeholder="https://..." /></div>
							<div><label className="text-xs text-muted font-semibold">Twitter/X</label><input value={twitter} onChange={e => setTwitter(e.target.value)} placeholder="username" /></div>
						</div>
						<div><label className="text-xs text-muted font-semibold">Slack Webhook</label><input value={slack} onChange={e => setSlack(e.target.value)} placeholder="https://hooks.slack.com/..." /></div>
						<button type="button" onClick={saveProfile} className="self-start text-sm px-4 py-2 rounded-xl bg-accent text-white font-bold">Save Profile</button>
					</div>
				</div>

				{/* Candidate Profile */}
				{cpFields.length > 0 && (
					<div className="mb-6">
						<h3 className="text-[0.95rem] font-semibold mb-1">Candidate Profile</h3>
						<p className="text-sm text-muted mb-3">Structured info your agents use to fill forms. Private — never shown publicly.</p>
						<div className="grid grid-cols-2 gap-2 max-sm:grid-cols-1">
							{identityFields.map(f => (
								<div key={f.key}>
									<label className="text-xs text-muted font-semibold">{f.label}{f.private ? <span className="text-muted-soft"> · private</span> : ""}</label>
									<input value={cpValues[f.key] || ""} onChange={e => setCpValues(p => ({ ...p, [f.key]: e.target.value }))} />
								</div>
							))}
						</div>
						{prefFields.length > 0 && (
							<>
								<div className="mt-3 font-bold text-sm">Job Preferences <span className="font-normal text-muted text-xs">— guides the agent's answers</span></div>
								<div className="grid grid-cols-2 gap-2 mt-1 max-sm:grid-cols-1">
									{prefFields.map(f => (
										<div key={f.key}>
											<label className="text-xs text-muted font-semibold">{f.label}</label>
											<input value={cpValues[f.key] || ""} onChange={e => setCpValues(p => ({ ...p, [f.key]: e.target.value }))} />
										</div>
									))}
								</div>
							</>
						)}
						<div className="flex items-center gap-2 mt-3">
							<button type="button" onClick={saveCandidateProfile} className="text-sm px-4 py-2 rounded-xl bg-accent text-white font-bold">Save Candidate Profile</button>
							{cpStatus && <span className="text-xs text-muted">{cpStatus}</span>}
						</div>
					</div>
				)}

				{/* API Token */}
				<div className="mb-6">
					<h3 className="text-[0.95rem] font-semibold mb-3">API Token</h3>
					<div className="flex items-center gap-2">
						<span className="bg-paper border border-line rounded-md px-2.5 py-1.5 font-mono text-xs text-muted max-w-[220px] truncate">
							{tokenVisible && token ? token : token ? `${token.slice(0, 12)}...` : "Not signed in"}
						</span>
						<button type="button" onClick={() => { if (token) navigator.clipboard.writeText(token); }} className="text-xs px-2 py-1 border border-line rounded text-muted">Copy</button>
						<button type="button" onClick={() => setTokenVisible(!tokenVisible)} className="text-xs px-2 py-1 border border-line rounded text-muted">{tokenVisible ? "Hide" : "Show"}</button>
					</div>
				</div>

				{/* Billing — the $9/mo Pro subscription */}
				<div className="mb-6">
					<h3 className="text-[0.95rem] font-semibold mb-3">Billing</h3>
					{!billing ? (
						<p className="text-sm text-muted">Loading…</p>
					) : (
						<div className="bg-paper border border-line rounded-lg p-3 flex flex-col gap-2">
							<div className="flex items-center gap-2">
								<span className={`text-xs font-bold px-2 py-0.5 rounded-full ${billing.pro ? "bg-accent text-white" : "bg-line text-muted"}`}>
									{billing.pro ? "Pro" : "Free"}
								</span>
								<span className="text-sm text-muted">
									{billing.pro
										? billing.status === "canceled" && billing.expiresAt
											? `Cancelled — Pro until ${new Date(billing.expiresAt).toLocaleDateString()}`
											: billing.status === "past_due"
												? "Payment issue — please update your card"
												: "ProAgentStore Pro — $9/mo"
										: "Free plan: 2 agents, no local runner"}
								</span>
							</div>
							<div className="flex gap-2">
								{!billing.pro && (
									<button type="button" onClick={openCheckout} disabled={billingBusy} className="text-sm px-4 py-2 rounded-xl bg-accent text-white font-bold disabled:opacity-50">
										Upgrade to Pro — $9/mo
									</button>
								)}
								{billing.hasBillingAccount && (
									<button type="button" onClick={openPortal} disabled={billingBusy} className="text-sm px-3 py-2 rounded-xl border border-line text-muted font-semibold disabled:opacity-50">
										Manage subscription
									</button>
								)}
							</div>
							{billingMsg && <div className="text-sm text-muted">{billingMsg}</div>}
						</div>
					)}
				</div>

				{/* API Keys */}
				<div className="mb-6">
					<h3 className="text-[0.95rem] font-semibold mb-3">API Keys</h3>
					<p className="text-sm text-muted mb-3">Store your AI provider keys. Encrypted with AES-256-GCM.</p>
					{keysLoading ? <p className="text-sm text-muted">Loading keys...</p> : (
						<div className="flex flex-col gap-2">
							{providers.map(p => (
								<div key={p.id} className="flex items-center gap-3 p-2.5 bg-paper border border-line rounded-lg">
									<span className="text-sm font-medium flex-1">{p.name}</span>
									<span className={`text-xs ${p.hasKey ? "text-green" : "text-muted-soft"}`}>{p.hasKey ? "Stored" : "Not set"}</span>
									{p.hasKey ? (
										<button type="button" onClick={() => removeKey(p.id, p.name)} className="text-xs px-2 py-1 rounded border border-line text-muted">Remove</button>
									) : (
										<button type="button" onClick={() => addKey(p.id, p.name)} className="text-xs px-2 py-1 rounded bg-accent text-white font-bold">Add Key</button>
									)}
								</div>
							))}
						</div>
					)}
				</div>

				{/* Sign out */}
				<div className="mt-4">
					<button type="button" onClick={() => { signOut(); navigate("/"); }} className="bg-red text-white text-sm px-4 py-2 rounded-xl font-semibold hover:opacity-90">Sign Out</button>
				</div>
			</div>
		</div>
	);
}
