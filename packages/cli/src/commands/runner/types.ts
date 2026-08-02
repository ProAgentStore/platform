export interface RunnerStartOptions {
	host?: string;
	port?: string;
	dataDir?: string;
	token?: string;
	instanceId?: string;
	headless?: boolean;
}

export interface RunnerRequestOptions {
	url?: string;
	token?: string;
	instanceId?: string;
}

export interface PagsRequestOptions {
	apiBase?: string;
	pagsToken?: string;
}

export interface RuntimeRegisterOptions extends PagsRequestOptions, RunnerRequestOptions {
	endpointUrl: string;
	runnerToken?: string;
	placement?: string;
	runnerVersion?: string;
	capability?: string[];
	probe?: boolean;
}

export interface RunnerConnectOptions extends RunnerStartOptions, PagsRequestOptions {
	runnerVersion?: string;
}
