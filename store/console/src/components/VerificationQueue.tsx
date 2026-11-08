import { Link } from "react-router-dom";
import Button from "./Button";
import { type LeadVerification, leadVerificationLine } from "../lib/gmailScout";

/** A verification waiting on its site: the host to allow and the takeover that asks (#1604). */
export interface VerificationAsk {
	host: string;
	takeoverId: string;
}

export interface VerificationQueueProps {
	verifications: readonly LeadVerification[];
	/** Verify now / Verify again are off while something else is running. */
	busy: boolean;
	onVerify: (leadId: string) => void;
	/** Where an active lead is triaged (`/instances/<id>`), or null when the Data tab is not shown (#1602). */
	triageBase?: string | null;
	/** A lead that needs the owner, by lead id; with `onAllow`/`onDecline`, its row offers Allow and Decline like a takeover row. */
	asks?: Readonly<Record<string, VerificationAsk>>;
	onAllow?: (host: string) => void;
	onDecline?: (takeoverId: string) => void;
}

/**
 * The browser-verification queue (#1030): one sentence of help and a row per lead, with Verify now / Verify again.
 * Shared by the Gmail Scout's Scans tab (#1591) and the History `verifications` panel (#1604); static, so a unit test renders it.
 */
export default function VerificationQueue({ verifications, busy, onVerify, triageBase = null, asks = {}, onAllow, onDecline }: VerificationQueueProps) {
	return (
		<>
			<p className="text-xs text-muted mb-1">Leads the server could not check are checked in this Scout's browser — only the posting itself, never your alert link. Only a job found active can be applied for.</p>
			<ul className="flex flex-col gap-1 text-xs">
				{verifications.map((v) => {
					const line = leadVerificationLine(v);
					const ask = asks[v.leadId];
					return (
						<li key={v.leadId} data-testid="verification-row" className="flex flex-wrap gap-2 items-center">
							<span className={line.tone === "ok" ? "text-success" : line.tone === "warn" ? "text-warning" : "text-muted"}>{line.text}</span>
							{v.lastDetail && <span className="text-muted-soft">{v.lastDetail}</span>}
							{ask && onAllow && <Button size="sm" variant="primary" onClick={() => onAllow(ask.host)}>Allow {ask.host}</Button>}
							{ask && onDecline && <Button size="sm" variant="ghost" onClick={() => onDecline(ask.takeoverId)}>Decline</Button>}
							{line.canVerifyNow && <Button size="sm" variant="ghost" disabled={busy} onClick={() => onVerify(v.leadId)}>{v.state === "unverifiable" ? "Verify again" : "Verify now"}</Button>}
							{v.state === "active" && triageBase && <Link to={`${triageBase}/data?lead=${encodeURIComponent(v.leadId)}`} className="text-accent underline">Triage in Data</Link>}
						</li>
					);
				})}
			</ul>
		</>
	);
}
