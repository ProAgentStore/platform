/**
 * Which Application Tailor holds this application, for a caller that named some OTHER instance of the pipeline (#1548).
 *
 * `tailoring_run` reads one application's tailoring run, and that lives on the Tailor. The tool's schema asked for "any instance
 * of the pipeline" while the route scoped the lookup to the exact instance given, so the verified connected Runner (or the
 * Scout) got "Application not found" for an application that exists — a routing mismatch reported as a missing record, and the
 * canonical Tailor answered the same request. This resolves the Tailor the way `get_application` resolves pipeline membership:
 * from the OWNER'S OWN enabled connections (`pipelineOf`, user-scoped), never from an id the caller supplied. Every read after
 * it stays scoped to that owner and to the Tailor it names, so no instance of another owner can ever be reached through it.
 */
import type { Env } from "../../types.js";
import { getApplication } from "../local-artifact/store.js";
import { pipelineOf } from "./control.js";

type Held = NonNullable<Awaited<ReturnType<typeof getApplication>>>;

export interface TailorHolding {
	/** The Tailor whose records answered. */
	tailorInstanceId: string;
	application: Held;
}

/**
 * The Tailor in `instanceId`'s pipeline that holds `applicationId`, or null when none does.
 *
 * Throws 409 for an instance that is in no application pipeline at all (the same answer `get_application` gives). An application
 * id is a global primary key, so at most one Tailor can hold it: the first hit is the only one.
 */
export async function resolveTailorHolding(env: Env, uid: string, instanceId: string, applicationId: string): Promise<TailorHolding | null> {
	const pipeline = await pipelineOf(env, uid, instanceId);
	for (const tailorInstanceId of pipeline.tailors) {
		if (tailorInstanceId === instanceId) continue; // the caller already asked this one, and it did not hold it
		const application = await getApplication(env, tailorInstanceId, uid, applicationId);
		if (application) return { tailorInstanceId, application };
	}
	return null;
}

/** The honest 404 for an instance that is not a Tailor and has none to resolve to — not "the application is missing". */
export async function noTailorExplanation(env: Env, uid: string, instanceId: string): Promise<string | null> {
	const pipeline = await pipelineOf(env, uid, instanceId);
	if (pipeline.tailors.includes(instanceId)) return null;
	return pipeline.tailors.length ? null : "No Application Tailor is connected to this instance's pipeline, so there is no tailoring run to read here. Connect one, or pass the Tailor's instance_id.";
}
