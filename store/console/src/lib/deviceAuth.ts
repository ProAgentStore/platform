/** A machine's `pags login --device` request, as `GET /v1/auth/device/requests/:userCode` returns it (#1157). */
export interface DeviceRequestView {
	userCode: string;
	status: "pending" | "approved" | "denied" | "consumed";
	node: string | null;
	ip: string | null;
	country: string | null;
	/** What the machine asked for: `runner` = a runner-only sign-in (#1192); null = a full one. */
	requestedScope: "runner" | null;
	createdAt: string;
	expiresAt: string;
}

export interface DeviceRequestResponse {
	request: DeviceRequestView;
}

/** The answer to an approval or denial — null only if the request expired in between. */
export interface DeviceDecisionResponse {
	request: DeviceRequestView | null;
}
