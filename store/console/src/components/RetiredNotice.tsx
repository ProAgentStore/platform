/**
 * "Retired — disabled", said before anything is attempted (#979).
 *
 * The live state this closes: the legacy Job Application Assistant stayed in the console as an
 * ordinary `active` apply agent — same tabs, same board, same Loop button — beside the live
 * Scout → Tailor → Runner pipeline, which is also an apply agent. The only way to find out it
 * could not work was to try to use it, and the refusal came back as an error on an action the UI
 * had just offered.
 *
 * Two pieces, because the issue asks for two: a BADGE for every surface that names the instance
 * (its header, its card) and a BANNER wherever its own page is open, carrying the explanation, the
 * promise that nothing was deleted, and a link straight to the owner's replacement pipeline.
 */
import { AlertTriangle, ArrowRight } from "lucide-react";
import { type InstanceRetirement, replacementRoutes, retiredTitle } from "../lib/retirement";

/** The pill. Danger-toned on purpose: this is not a warning about something that might happen. */
export function RetiredBadge({ retirement, className = "" }: { retirement: InstanceRetirement; className?: string }) {
	return (
		<span
			data-testid="retired-badge"
			title={retiredTitle(retirement)}
			className={`px-1.5 py-0.5 rounded-full text-2xs font-bold bg-danger-soft text-danger shrink-0 whitespace-nowrap ${className}`}
		>
			{retirement.label}
		</span>
	);
}

/**
 * The banner, on every surface of a retired instance.
 *
 * It states three things in the order an owner needs them: this does not run, nothing you had is
 * gone, and here is what to use. The links are the owner's own instances when they have them —
 * resolved server-side so this cannot point at an instance that does not exist — and a sentence
 * naming what to subscribe to when they do not.
 */
export default function RetiredNotice({ retirement, onOpen }: { retirement: InstanceRetirement; onOpen?: (path: string) => void }) {
	const routes = replacementRoutes(retirement);
	return (
		<div data-testid="retired-banner" role="status" className="m-2 p-3 border border-danger rounded-xl bg-danger-soft">
			<div className="flex items-start gap-2">
				<AlertTriangle size={16} className="text-danger shrink-0 mt-0.5" aria-hidden="true" />
				<div className="min-w-0 flex-1">
					<p className="text-sm font-bold text-danger">
						{retirement.label} <span className="font-medium">· since {retirement.since}</span>
					</p>
					<p className="text-xs text-ink mt-1">{retirement.summary}</p>
					<p className="text-xs text-muted mt-1">{retirement.preserved}</p>
					<p className="text-xs text-ink mt-2 font-semibold">Use {retirement.replacement.pipeline} instead:</p>
					<ul className="mt-1 flex flex-col gap-1">
						{routes.map((route) => (
							<li key={route.key} className="text-xs">
								{route.href ? (
									<button
										type="button"
										onClick={() => onOpen?.(route.href as string)}
										className="inline-flex items-center gap-1 font-bold text-accent hover:underline"
									>
										{route.label} <ArrowRight size={12} aria-hidden="true" />
									</button>
								) : (
									<span className="font-bold text-muted">{route.label}</span>
								)}
								<span className="text-muted"> — {route.does}</span>
								{route.hint && <span className="text-muted italic"> ({route.hint})</span>}
							</li>
						))}
					</ul>
				</div>
			</div>
		</div>
	);
}
