import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";

interface Props {
	instanceId: string;
	isApply: boolean;
	onUnsubscribe: () => void;
}

export default function SettingsTab({ instanceId, isApply, onUnsubscribe }: Props) {
	const [maintMsg, setMaintMsg] = useState("");
	const [runtimeInfo, setRuntimeInfo] = useState<Record<string, unknown> | null>(null);

	useEffect(() => {
		(async () => {
			try {
				const d = await api<Record<string, unknown>>(`/v1/instances/${instanceId}/runtime/status`);
				setRuntimeInfo(d);
			} catch {}
		})();
	}, [instanceId]);

	const clearFinished = async () => {
		try {
			await api(`/v1/instances/${instanceId}/tasks/clear-finished`, { method: "POST" });
			setMaintMsg("Cleared finished tasks");
			setTimeout(() => setMaintMsg(""), 3000);
		} catch (e) {
			setMaintMsg(e instanceof Error ? e.message : "Failed");
		}
	};

	const unsubscribe = async () => {
		if (!confirm("Unsubscribe from this agent? Your data stays unless you clear it.")) return;
		try {
			await api(`/v1/instances/${instanceId}/cancel`, { method: "POST" });
			onUnsubscribe();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	return (
		<div>
			{/* Board maintenance */}
			<div className="bg-panel border border-line rounded-xl p-4 mb-4">
				<h3 className="text-base font-semibold mb-1">Board maintenance</h3>
				<p className="text-sm text-muted mb-3">
					Tidy up the board. These only clear your view of finished items.
				</p>
				<div className="flex gap-2 flex-wrap">
					<button
						type="button"
						onClick={clearFinished}
						className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-semibold"
					>
						Clear finished tasks
					</button>
				</div>
				{maintMsg && <div className="text-sm text-muted mt-2">{maintMsg}</div>}
			</div>

			{/* Runner info */}
			<div className="bg-panel border border-line rounded-xl p-4 mb-4">
				<h3 className="text-base font-semibold mb-1">Runner</h3>
				<div className="text-sm text-muted leading-relaxed">
					{runtimeInfo ? (
						<>
							Status: {String((runtimeInfo as Record<string, unknown>).connected ? "Online" : "Offline")}
							{(runtimeInfo as Record<string, unknown>).node && (
								<> · Node: {String((runtimeInfo as Record<string, unknown>).node)}</>
							)}
						</>
					) : (
						"Checking runner status..."
					)}
				</div>
			</div>

			{/* Where things live */}
			<div className="bg-panel border border-line rounded-xl p-4 mb-4">
				<h3 className="text-base font-semibold mb-1">Where things live</h3>
				<ul className="text-sm text-muted leading-relaxed pl-4 list-disc">
					{isApply && <li><b>Resume</b> & documents → Knowledge → Documents</li>}
					{isApply && <li><b>Candidate profile</b> & job preferences → Profile</li>}
					<li><b>Rules / special instructions</b> → Knowledge → Rules & Tips</li>
					<li><b>Logins & secrets</b> → Knowledge → Credentials</li>
				</ul>
			</div>

			{/* Danger zone */}
			<div className="bg-panel border border-line rounded-xl p-4">
				<h3 className="text-base font-semibold mb-1 text-red">Danger zone</h3>
				<p className="text-sm text-muted mb-3">
					Stop using this agent. Your data stays unless you clear it above.
				</p>
				<button
					type="button"
					onClick={unsubscribe}
					className="text-xs px-3 py-1.5 rounded-lg border border-red text-red font-semibold hover:bg-red/10"
				>
					Unsubscribe from this agent
				</button>
			</div>
		</div>
	);
}
