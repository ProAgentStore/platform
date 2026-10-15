import type { Env } from "../../types.js";
import { timingSafeEqualStr } from "../crypto.js";
import { hmac } from "./capture-artifacts.js";

/**
 * The run-scoped credential the Website Builder's local author uses to reach PAGS's broker (#841, PR842).
 *
 * The runner otherwise holds no PAGS credential at all — PAGS pulls from it over the relay. The one
 * exception is this: an HMAC over (purpose, owner, instance, run, expiry) with the platform signing
 * key, the same construction as the signed capture URLs beside it (`capture-artifacts.ts`). It names
 * one run of one owner's instance and expires, so it can do exactly what the broker allows for that
 * run — the FreeWebStore authoring tools and the run's evidence — and nothing else: it is not a
 * session, and `verifySession` would never accept it. A closed run refuses it whatever its expiry.
 */
export const BROKER_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/** Where the runner may send it — the runner pins the same prefix before it sends anything. */
export const BROKER_BASE_URL = "https://api.proagentstore.online/v1/site-builder/broker/";

const PURPOSE = "site-builder-broker";

interface RunIds {
	userId: string;
	instanceId: string;
	runId: string;
}

const signed = (ids: RunIds, exp: number) => `${PURPOSE}.${ids.userId}.${ids.instanceId}.${ids.runId}.${exp}`;

export async function mintBrokerToken(env: Pick<Env, "SESSION_SIGNING_KEY">, ids: RunIds, now = Date.now()): Promise<string> {
	const exp = now + BROKER_TOKEN_TTL_MS;
	return `${exp}.${await hmac(env, signed(ids, exp))}`;
}

export async function verifyBrokerToken(env: Pick<Env, "SESSION_SIGNING_KEY">, ids: RunIds, token: string, now = Date.now()): Promise<boolean> {
	const dot = token.indexOf(".");
	if (dot < 1) return false;
	const exp = Number(token.slice(0, dot));
	if (!Number.isSafeInteger(exp) || exp < now) return false;
	return timingSafeEqualStr(await hmac(env, signed(ids, exp)), token.slice(dot + 1));
}
