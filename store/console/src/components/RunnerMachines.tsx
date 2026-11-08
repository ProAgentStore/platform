import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { compactMachineStatus, type MachineTile, otherMachinesText } from "../lib/runnerPanel";

/**
 * The machine part of the Runner card (#1594): the ONE machine this instance is pinned to, in
 * detail, then a count of the rest and a "Change machine" choice. The fleet lives on Terminals.
 * Presentational so the pinned-only view, the N line and the machine link render without the
 * card's fetches. Which tiles are which is `runnerCardView`'s call.
 */
export interface RunnerMachinesProps {
	pinned: MachineTile | null;
	others: MachineTile[];
	onPick: (node: string) => void;
}

function Dot({ t }: { t: MachineTile }) {
	// Green is reserved for "work runs here"; a machine up but serving this agent nothing is amber.
	return <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${t.tone === "attached" ? "bg-success" : t.tone === "offline" ? "bg-muted-soft" : "bg-amber-500"}`} />;
}

/** Every machine, compactly: name, up or down, attached to this agent. No alerts or health. */
function MachineChoices({ tiles, onPick, firstRef }: { tiles: MachineTile[]; onPick: (node: string) => void; firstRef?: React.Ref<HTMLButtonElement> }) {
	return (
		<ul className="flex flex-col gap-1.5 list-none p-0 m-0" data-testid="runner-machine-choices">
			{tiles.map((t, i) => (
				<li key={t.node}>
					<button
						type="button"
						ref={i === 0 ? firstRef : undefined}
						data-testid="runner-machine-choice"
						aria-pressed={t.pinned}
						onClick={() => onPick(t.node)}
						title={t.pinned ? "This agent is bound to this machine" : "Bind this agent to this machine"}
						className={`w-full min-h-[44px] text-left rounded-lg border px-3 py-2 flex items-center gap-2 min-w-0 transition-colors ${t.pinned ? "border-accent bg-accent-soft" : "border-line bg-paper hover:border-accent/60"}`}
					>
						<Dot t={t} />
						<span className="min-w-0 flex-1">
							<span className="block font-semibold text-sm break-words">{t.label}</span>
							<span className="block text-2xs text-muted-soft break-words">{compactMachineStatus(t)}</span>
						</span>
						{t.pinned && <span className="shrink-0 text-2xs font-bold uppercase tracking-wide text-accent border border-accent/40 rounded px-1.5 py-0.5">Pinned</span>}
					</button>
				</li>
			))}
		</ul>
	);
}

export default function RunnerMachines({ pinned, others, onPick }: RunnerMachinesProps) {
	const [open, setOpen] = useState(false);
	const firstRef = useRef<HTMLButtonElement>(null);
	// Focus moves into the list on open, so a keyboard user lands on the choices rather than past them.
	useEffect(() => {
		if (open) firstRef.current?.focus();
	}, [open]);

	// No pin: there is nothing to scope to, so the choices are the card.
	if (!pinned) return <MachineChoices tiles={others} onPick={onPick} />;

	const t = pinned;
	const choices = [t, ...others];
	return (
		<>
			<div className="rounded-xl border border-accent bg-accent-soft p-3" data-testid="runner-pinned-machine">
				<div className="flex items-center gap-2 min-w-0">
					<Dot t={t} />
					{t.machineId ? (
						<Link to={`/terminals/machines/${encodeURIComponent(t.machineId)}`} className="font-semibold text-sm truncate hover:text-accent" data-testid="runner-machine-link">
							{t.label}
						</Link>
					) : (
						<span className="font-semibold text-sm truncate">{t.label}</span>
					)}
					<span className="ml-auto shrink-0 text-2xs font-bold uppercase tracking-wide text-accent border border-accent/40 rounded px-1.5 py-0.5">Pinned</span>
				</div>
				{/* `break-words`: a hostname is one unbreakable token, wider than the card at 320px. */}
				<div className={`text-2xs mt-1 break-words ${t.tone === "attached" ? "text-success" : t.tone === "offline" ? "text-muted-soft" : "text-amber-500"}`}>{t.statusText}</div>
				<div className="text-2xs text-muted-soft mt-0.5">{t.meta}</div>
				{t.alsoKnownAs && <div className="text-2xs text-muted-soft mt-0.5 truncate">{t.alsoKnownAs}</div>}
				{t.health && <div className="text-2xs text-muted-soft mt-0.5">{t.health}</div>}
				{t.alerts.length > 0 && <div className="text-2xs text-warning mt-0.5 break-words">⚠ {t.alerts.join(" · ")}</div>}
				{t.outdated && <div className="text-2xs text-warning mt-0.5">CLI out of date — update it from Terminals</div>}
			</div>
			<div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
				{others.length > 0 && (
					<span data-testid="runner-other-machines">
						{otherMachinesText(others.length)} · <Link to="/terminals" className="underline text-accent">Manage machines</Link>
					</span>
				)}
				{others.length > 0 && (
					<button
						type="button"
						aria-expanded={open}
						aria-controls="runner-change-machine"
						onClick={() => setOpen((o) => !o)}
						data-testid="runner-change-machine"
						className="ml-auto min-h-[24px] underline text-accent font-semibold"
					>
						Change machine
					</button>
				)}
			</div>
			{open && (
				<div id="runner-change-machine" className="mt-2">
					<MachineChoices tiles={choices} onPick={(n) => { setOpen(false); onPick(n); }} firstRef={firstRef} />
				</div>
			)}
		</>
	);
}
