import { HttpError } from "../auth.js";
import type { McpImageArtifact } from "../connectors/mcp.js";
import { timingSafeEqualStr } from "../crypto.js";
import type { Env } from "../../types.js";
import type { RuntimeBuilderRun, ScreenshotArtifact } from "./types.js";

/** Two responsive captures, each small enough to deliver reliably over the relay. */
export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
export const CAPTURE_URL_TTL_MS = 15 * 60 * 1000;
const API_PUBLIC_BASE = "https://api.proagentstore.online";
const ACCEPTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export interface CaptureRequest {
	device: "desktop" | "mobile";
	viewport?: { width?: unknown; height?: unknown };
}

export interface RuntimeCaptureArtifact extends ScreenshotArtifact {
	id: string;
	contentType: string;
	bytes: number;
	width?: number;
	height?: number;
}

interface DeliveryArtifact {
	id: string;
	device: "desktop" | "mobile";
	contentType: string;
	bytes: number;
	width?: number;
	height?: number;
	url: string;
}

const artifactKey = (userId: string, instanceId: string, runId: string, artifactId: string) =>
	`site-builder-captures/${userId}/${instanceId}/${runId}/${artifactId}`;

function base64Bytes(value: string): Uint8Array {
	// MCP image blocks are base64, never data URLs. Rejecting malformed values instead of
	// "repairing" them keeps the max-byte policy meaningful.
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new HttpError(400, "FWS capture image is not valid base64");
	try {
		const decoded = atob(value);
		return Uint8Array.from(decoded, (c) => c.charCodeAt(0));
	} catch {
		throw new HttpError(400, "FWS capture image is not valid base64");
	}
}

function boundedDimension(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 10_000 ? value : undefined;
}

async function digest(bytes: Uint8Array): Promise<string> {
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(env: Env, value: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SESSION_SIGNING_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
	return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function verifiedCaptureRequest(value: unknown): Promise<CaptureRequest> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "capture details are required");
	const request = value as Record<string, unknown>;
	if (request.device !== "desktop" && request.device !== "mobile") throw new HttpError(400, "capture device must be desktop or mobile");
	const viewport = request.viewport && typeof request.viewport === "object" && !Array.isArray(request.viewport)
		? request.viewport as Record<string, unknown>
		: undefined;
	return { device: request.device, ...(viewport ? { viewport } : {}) };
}

/** Convert the exact MCP image block into a bounded, content-addressed job artifact. */
export async function storeCaptureArtifact(
	env: Env,
	run: RuntimeBuilderRun,
	request: CaptureRequest,
	images: unknown[],
): Promise<RuntimeCaptureArtifact> {
	if (images.length !== 1) throw new HttpError(502, "FWS capture_preview must return exactly one image");
	const image = images[0] as Partial<McpImageArtifact>;
	if (image.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string" || !ACCEPTED_IMAGE_TYPES.has(image.mimeType)) {
		throw new HttpError(502, "FWS capture_preview returned an unsupported image artifact");
	}
	const bytes = base64Bytes(image.data);
	if (!bytes.byteLength || bytes.byteLength > MAX_CAPTURE_BYTES) throw new HttpError(413, `FWS capture image exceeds ${MAX_CAPTURE_BYTES} bytes`);
	const id = await digest(bytes);
	const width = boundedDimension(request.viewport?.width);
	const height = boundedDimension(request.viewport?.height);
	try {
		await env.STORAGE.put(artifactKey(run.userId, run.instanceId, run.id, id), bytes, {
			httpMetadata: { contentType: image.mimeType },
			customMetadata: { device: request.device, ...(width ? { width: String(width) } : {}), ...(height ? { height: String(height) } : {}) },
		});
	} catch {
		// Nothing is written to durable evidence until R2 has the bytes. Retrying the
		// capture is idempotent because the key is the content digest.
		throw new HttpError(502, "Couldn't store the FWS capture; retry the capture");
	}
	return { id, device: request.device, contentType: image.mimeType, bytes: bytes.byteLength, ...(width ? { width } : {}), ...(height ? { height } : {}), capturedAt: new Date().toISOString() };
}

export async function signedCaptureDelivery(env: Env, run: RuntimeBuilderRun, artifact: RuntimeCaptureArtifact): Promise<DeliveryArtifact> {
	const exp = Date.now() + CAPTURE_URL_TTL_MS;
	const token = await hmac(env, `${run.userId}.${run.instanceId}.${run.id}.${artifact.id}.${exp}`);
	const query = new URLSearchParams({ uid: run.userId, exp: String(exp), token });
	return { ...artifact, url: `${API_PUBLIC_BASE}/v1/instances/${encodeURIComponent(run.instanceId)}/site-builder/${encodeURIComponent(run.id)}/artifacts/${artifact.id}?${query.toString()}` };
}

/** HMAC plus the run's three ownership ids makes this URL useful only for this one job. */
export async function verifyCaptureDelivery(env: Env, input: { userId: string; instanceId: string; runId: string; artifactId: string; exp: string; token: string }): Promise<boolean> {
	if (!input.userId || !input.exp || !input.token || !/^[a-f0-9]{64}$/.test(input.artifactId) || Date.now() > Number(input.exp)) return false;
	const expected = await hmac(env, `${input.userId}.${input.instanceId}.${input.runId}.${input.artifactId}.${input.exp}`);
	return timingSafeEqualStr(expected, input.token);
}

export function captureObjectKey(userId: string, instanceId: string, runId: string, artifactId: string): string {
	return artifactKey(userId, instanceId, runId, artifactId);
}
