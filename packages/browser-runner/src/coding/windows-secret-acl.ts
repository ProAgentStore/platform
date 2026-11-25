import { execFileSync } from "node:child_process";
import { join } from "node:path";

// Set and read back the DACL before secret bytes are written. Only the path reaches
// PowerShell: the secret is never an argument, environment value or subprocess input.
// https://learn.microsoft.com/powershell/module/microsoft.powershell.security/set-acl
const PROTECT = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'Read, Write, Delete, ChangePermissions', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:PAGS_SECRET_ACL_PATH -AclObject $acl
$actual = Get-Acl -LiteralPath $env:PAGS_SECRET_ACL_PATH
$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if (!$actual.AreAccessRulesProtected -or $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne $rule.FileSystemRights) { throw 'ACL verification failed' }
[Console]::Write('protected')
`;

export function protectWindowsSecretFile(path: string): void {
	const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	let result: string;
	try {
		result = execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", PROTECT], {
			// PSModulePath is dropped: a runner started from PowerShell 7 carries that edition's module path, and Windows PowerShell 5.1
			// then cannot autoload Microsoft.PowerShell.Security ("Set-Acl is not recognized"). Unset, 5.1 computes its own.
			env: { ...process.env, PSModulePath: undefined, PAGS_SECRET_ACL_PATH: path },
			encoding: "utf8", timeout: 10_000, windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (e) {
		// PowerShell's own message names the failing step; the secret was never passed to it, so it cannot appear there.
		const detail = String((e as { stderr?: unknown }).stderr ?? "").replace(/\s+/g, " ").trim();
		const shown = detail.length <= 300 ? detail : `[...truncated...] ${detail.slice(-300)}`;
		throw new Error(`ACL protection failed${shown ? `: ${shown}` : ""}`);
	}
	if (result !== "protected") throw new Error("ACL verification did not complete");
}
