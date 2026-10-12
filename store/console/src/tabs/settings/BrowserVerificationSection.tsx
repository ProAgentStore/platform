import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Button from "../../components/Button";
import Card from "../../components/Card";
import LoadFailed from "../../components/LoadFailed";
import { type BrowserTakeover, type BrowserTakeoverListResponse, isLive, takeoverLine } from "../../lib/browserTakeovers";
import { type BrowserRuntimesView, type BrowserVerificationSettings, type BrowserVerificationView, changedFields, EVENT_WORDS, machineLine } from "../../lib/browserVerification";

const input = "bg-paper border border-line rounded px-2 py-1.5 text-sm";

/**
 * Settings → Browser verification (#1031). Turns the agent's DECLARED local browser on for this
 * instance and says where and how it runs. It does not pin the machine (the Runner card does), grant
 * site consent (Local browser research above) or decide pushes (Notifications) — the same split MCP's
 * set_instance_browser_verification keeps, from the same route.
 */
export default function BrowserVerificationSection({ instanceId }: { instanceId: string }) {
	const [data, setData] = useState<BrowserVerificationView | null>(null);
	const [form, setForm] = useState<BrowserVerificationSettings | null>(null);
	const [runtimes, setRuntimes] = useState<BrowserRuntimesView | null>(null);
	const [checking, setChecking] = useState(false);
	const [error, setError] = useState("");
	const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
	const [saving, setSaving] = useState(false);
	// The durable takeovers (#1031) — the same rows browser_takeover_list reads.
	const [takeovers, setTakeovers] = useState<BrowserTakeover[]>([]);

	const load = useCallback(async () => {
		try {
			const [v, t] = await Promise.all([
				api<BrowserVerificationView>(`/v1/instances/${instanceId}/browser-verification`),
				api<BrowserTakeoverListResponse>(`/v1/instances/${instanceId}/browser-takeovers?limit=10`).catch((): BrowserTakeoverListResponse => ({ takeovers: [] })),
			]);
			setTakeovers(t.takeovers);
			setData(v);
			setForm(v.settings);
			setError("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [instanceId]);
	useEffect(() => {
		load();
	}, [load]);

	if (error && !data) return <LoadFailed what="browser verification settings" detail={error} onRetry={load} />;
	if (!data || !form) return null;
	const set = (patch: Partial<BrowserVerificationSettings>) => setForm((f) => (f ? { ...f, ...patch } : f));
	const patch = changedFields(data.settings, form);

	const save = async () => {
		setSaving(true);
		setMsg(null);
		try {
			const v = await api<BrowserVerificationView>(`/v1/instances/${instanceId}/browser-verification`, { method: "PUT", body: JSON.stringify(patch) });
			setData(v);
			setForm(v.settings);
			setMsg({ tone: "ok", text: "Saved." });
		} catch (e) {
			// The server's refusal, as it is: nothing here is clamped to make it fit.
			setMsg({ tone: "warn", text: e instanceof Error ? e.message : String(e) });
		}
		setSaving(false);
	};

	const decline = async (id: string) => {
		try {
			await api(`/v1/instances/${instanceId}/browser-takeovers/${id}`, { method: "PATCH", body: JSON.stringify({ state: "ended" }) });
			await load();
		} catch (e) {
			setMsg({ tone: "warn", text: e instanceof Error ? e.message : String(e) });
		}
	};

	const check = async () => {
		setChecking(true);
		try {
			setRuntimes(await api<BrowserRuntimesView>(`/v1/instances/${instanceId}/browser-verification/runtimes`));
		} catch (e) {
			setMsg({ tone: "warn", text: e instanceof Error ? e.message : String(e) });
		}
		setChecking(false);
	};

	return (
		<Card className="mb-3 sm:mb-4" data-testid="browser-verification-card">
			<h3 className="text-base font-bold mb-1">Browser verification</h3>
			<p className="text-sm text-muted mb-3">
				Lets this agent check pages the server cannot fetch, in your own browser on your machine. The machine is the one chosen in the Runner card; site consent is in Local browser research.
			</p>
			{!data.capability.declared && <p className="text-sm text-warning mb-3">This agent does not declare a local browser, so verification cannot be turned on for it.</p>}
			<label className="flex gap-2 items-center text-sm mb-3">
				<input type="checkbox" checked={form.enabled} disabled={!data.capability.declared && !form.enabled} onChange={(e) => set({ enabled: e.target.checked })} data-testid="bv-enabled" />
				Verify in my browser
			</label>
			<div className="grid sm:grid-cols-2 gap-3 mb-3">
				<label className="flex flex-col gap-1 text-xs font-semibold">
					Runs on
					<select className={input} value={form.runtime} onChange={(e) => set({ runtime: e.target.value as BrowserVerificationSettings["runtime"] })}>
						<option value="pinned">Only the pinned machine{data.runnerNode ? ` (${data.runnerNode})` : ""}</option>
						<option value="any_eligible">Any eligible machine, pinned first</option>
					</select>
				</label>
				<label className="flex flex-col gap-1 text-xs font-semibold">
					When no machine is available
					<select className={input} value={form.fallback} onChange={(e) => set({ fallback: e.target.value as BrowserVerificationSettings["fallback"] })}>
						<option value="wait">Wait for one</option>
						<option value="mark_unverifiable">Mark it unverifiable</option>
					</select>
				</label>
				{form.fallback === "wait" && (
					<label className="flex flex-col gap-1 text-xs font-semibold">
						Wait up to (minutes)
						<input className={input} type="number" min={1} max={1440} value={form.waitLimitMinutes} onChange={(e) => set({ waitLimitMinutes: Number(e.target.value) })} />
					</label>
				)}
				<label className="flex flex-col gap-1 text-xs font-semibold">
					When a run needs you
					<select className={input} value={form.takeover} onChange={(e) => set({ takeover: e.target.value as BrowserVerificationSettings["takeover"] })}>
						<option value="prompt">Ask me to take over</option>
						<option value="never">Stop that attempt instead</option>
					</select>
				</label>
			</div>
			{form.takeover === "prompt" && (
				<label className="flex gap-2 items-center text-sm mb-3">
					<input type="checkbox" checked={form.allowMobile} onChange={(e) => set({ allowMobile: e.target.checked })} />
					Let me take over from my phone
				</label>
			)}
			<p className="text-xs text-muted mb-3">
				It tells you when {data.notificationEvents.map((e) => EVENT_WORDS[e] ?? e.replace(/_/g, " ")).join(", ")}. Which of those reach your phone is set in Notifications.
			</p>
			<div className="flex gap-2 items-center">
				<Button size="sm" onClick={save} disabled={saving || !Object.keys(patch).length} data-testid="bv-save">Save</Button>
				<Button size="sm" onClick={check} disabled={checking} data-testid="bv-check">{checking ? "Checking…" : "Check machines"}</Button>
				{msg && <span role="status" className={`text-xs ${msg.tone === "ok" ? "text-success" : "text-warning"}`}>{msg.text}</span>}
			</div>
			{runtimes && (
				<ul className="mt-3 text-xs flex flex-col gap-1" data-testid="bv-machines">
					{runtimes.machines.map((m) => {
						const line = machineLine(m);
						return (
							<li key={m.node}>
								<b>{m.node}</b>
								{m.pinned && " (pinned)"}: <span className={line.good ? "text-success" : "text-warning"}>{line.verdict}</span>
								<span className="text-muted"> — {line.facts}</span>
								{m.detail && <div className="text-muted-soft">{m.detail}</div>}
							</li>
						);
					})}
					<li className="mt-1">{runtimes.selected ? <>Would run on <b>{runtimes.selected}</b>.</> : <span className="text-warning">{runtimes.detail}</span>}</li>
				</ul>
			)}
			{takeovers.length > 0 && (
				<div className="mt-4" data-testid="bv-takeovers">
					<div className="text-xs font-semibold mb-1">Recent takeovers</div>
					<ul className="text-xs flex flex-col gap-1">
						{takeovers.map((t) => (
							<li key={t.id} className="flex flex-wrap gap-2 items-center">
								<span className={takeoverLine(t).tone === "warn" ? "text-warning" : "text-muted"}>{takeoverLine(t).text}</span>
								<span className="text-muted-soft">{t.subjectKind.replace(/_/g, " ")} · {t.createdAt.slice(0, 16).replace("T", " ")}</span>
								{isLive(t) && <Button size="sm" variant="ghost" onClick={() => void decline(t.id)}>Decline</Button>}
							</li>
						))}
					</ul>
				</div>
			)}
		</Card>
	);
}
