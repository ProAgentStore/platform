export interface CheckResult {
	name: string;
	pass: boolean;
	message: string;
	severity: "error" | "warning" | "info";
}
