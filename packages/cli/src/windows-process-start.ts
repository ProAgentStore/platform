import { execFileSync } from "node:child_process";

/** Windows process identity, in the same DMTF format used by the retired WMIC probe. */
export function windowsProcessStartedAt(pid: number): string {
	if (!Number.isSafeInteger(pid) || pid <= 0) return "";
	try {
		const out = execFileSync("powershell.exe", [
			"-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
			`$ErrorActionPreference = 'Stop'; $p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($null -ne $p.CreationDate) { [System.Management.ManagementDateTimeConverter]::ToDmtfDateTime($p.CreationDate) }`,
		], { encoding: "utf-8", timeout: 4000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
		// Never turn diagnostic output, missing evidence or an unavailable CIM provider into identity.
		return /^\d{14}\.\d{6}[+-]\d{3}$/.test(out) ? out : "";
	} catch {
		return "";
	}
}
