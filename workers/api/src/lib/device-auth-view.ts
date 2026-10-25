/**
 * What the device sign-in approval page reads (#1157). A leaf with no imports, so the console's type test can compare
 * against it without pulling in the Worker's bindings (`types.ts`).
 */
export interface DeviceRequestView {
	userCode: string;
	status: "pending" | "approved" | "denied" | "consumed";
	node: string | null;
	ip: string | null;
	country: string | null;
	/** What the machine asked for: `runner` = a runner-only sign-in (#1192); null = a full one. The owner decides on approval. */
	requestedScope: "runner" | null;
	createdAt: string;
	expiresAt: string;
}

/** `GET /v1/auth/device/requests/:userCode`. */
export interface DeviceRequestResponse {
	request: DeviceRequestView;
}

/** `POST /v1/auth/device/requests/:userCode` — the request as decided (null only if it expired in between). */
export interface DeviceDecisionResponse {
	request: DeviceRequestView | null;
}
