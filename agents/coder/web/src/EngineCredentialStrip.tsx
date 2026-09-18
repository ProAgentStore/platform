import { Cpu } from "lucide-react";
import { engineAuthBadge, type EngineAuthReport } from "./engine-auth-view";
import { engineInvocationBadge, type EngineInvocationReport } from "./engine-invocation-mode";

/**
 * Which credential this session actually used, and what the engine actually is (#248).
 *
 * Shown in BOTH the Co-pilot and Terminal views because the question it answers — "am I burning
 * API credits or using the subscription I already pay for?" — had no answer anywhere in the
 * product, and the one documented way it goes wrong is silent.
 *
 * The badge and the invocation line are deliberately ONE block with a shared `warn` tone rather
 * than two independent notices (#731): an engine that is signed in but running raw is one
 * situation, and reporting it as two adjacent warnings is how this strip would keep widening.
 *
 * Both readings are pure and tested elsewhere (./engine-auth-view, ./engine-invocation-mode);
 * this takes the two `/capture` reports and nothing else, which is why it could leave CodingTab.
 * Null reports — an older runner — render nothing.
 */
export default function EngineCredentialStrip({ auth, invocation: invocationReport }: { auth: EngineAuthReport | null; invocation: EngineInvocationReport | null }) {
	const badge = engineAuthBadge(auth);
	const invocation = engineInvocationBadge(invocationReport);
	if (!badge && !invocation) return null;
	const warn = badge?.tone === "warn" || invocation?.tone === "warn";
	return (
		<div className={`mb-2 rounded-lg border px-3 py-2 ${warn ? "border-warning-line bg-warning-soft" : "border-line"}`}>
			{badge && <div className="flex items-center gap-1.5 text-xs font-bold">
				<Cpu size={12} className={warn ? "text-warning" : "text-muted"} />
				<span>{badge.label}</span>
			</div>}
			{badge && <p className="text-2xs text-muted mt-0.5">{badge.detail}</p>}
			{/* The ordinary case, stated (#343). `warning` only fires on a mismatch, so
			    the most common resolution — this machine's own login — showed nothing
			    at all, which is precisely the configuration where the owner cannot
			    tell which account is paying. */}
			{badge?.note && <p className="text-2xs text-muted-soft mt-1">{badge.note}</p>}
			{auth?.warning && <p className="text-xs text-warning mt-1">{auth.warning}</p>}
			{invocation && (
				<p className="text-2xs text-muted mt-1">
					<b>{invocation.label}.</b> {invocation.detail}
				</p>
			)}
			{invocationReport?.warning && <p className="text-xs text-warning mt-1">{invocationReport.warning}</p>}
		</div>
	);
}
