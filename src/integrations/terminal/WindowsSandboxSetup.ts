import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { execa } from "execa"
import { t } from "../../i18n"
import type { SandboxedCommand } from "./CommandSandbox"

// ACLs and the native setup marker persist globally. Cache only successful checks within this host.
const ready = new Map<string, Promise<void>>()

export function windowsProfileReadScript(profile: string): string {
	const encoded = Buffer.from(profile).toString("base64")
	return String.raw`
$ErrorActionPreference = 'Stop'
$profileDirectory = Get-Item -LiteralPath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))
if (-not $profileDirectory.PSIsContainer -or ($profileDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'The sandbox profile must be an ordinary directory.'
}
$account = [Security.Principal.NTAccount]::new([Environment]::MachineName, 'CodexSandboxOnline')
$sid = $account.Translate([Security.Principal.SecurityIdentifier])
$rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $sid, [Security.AccessControl.FileSystemRights]::ReadAndExecute,
    [Security.AccessControl.InheritanceFlags]::None, [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
)
$acl = [Security.AccessControl.DirectorySecurity]::new($profileDirectory.FullName, [Security.AccessControl.AccessControlSections]::Access)
$existing = $acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]) | Where-Object {
    $_.IdentityReference -eq $sid -and $_.AccessControlType -eq 'Allow' -and
    $_.InheritanceFlags -eq 'None' -and ($_.FileSystemRights -band $rule.FileSystemRights) -eq $rule.FileSystemRights
}
if ($existing) { exit 0 }
$acl.AddAccessRule($rule)
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class AlphaDirectoryReadSetup {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("advapi32.dll", SetLastError=true)]
    static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
    [DllImport("advapi32.dll")]
    static extern uint SetSecurityInfo(SafeFileHandle handle, uint type, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    public static void Apply(string path, byte[] descriptor) {
        // MAXIMUM_ALLOWED suppresses child propagation; OPEN_REPARSE_POINT avoids following a replaced directory.
        // Set only DACL_SECURITY_INFORMATION, preserving ownership, auditing and integrity labels.
        using (var handle = CreateFile(path, 0x02000000, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            var pinned = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
            try {
                bool present, defaulted;
                IntPtr dacl;
                if (!GetSecurityDescriptorDacl(pinned.AddrOfPinnedObject(), out present, out dacl, out defaulted))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                if (!present || dacl == IntPtr.Zero) throw new InvalidOperationException("Refusing a null DACL.");
                uint error = SetSecurityInfo(handle, 1, 4, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
                if (error != 0) throw new Win32Exception((int)error);
            } finally { pinned.Free(); }
        }
    }
}
'@
[AlphaDirectoryReadSetup]::Apply($profileDirectory.FullName, $acl.GetSecurityDescriptorBinaryForm())
`
}

export async function ensureWindowsSandboxSetup(
	bootstrap: SandboxedCommand,
	cwd: string,
	signal?: AbortSignal,
): Promise<void> {
	if (process.platform !== "win32") return
	signal?.throwIfAborted()
	const home = bootstrap.env.CODEX_HOME!
	const profile = await fs.realpath(os.homedir())
	const key = JSON.stringify([home, profile])
	let preparing = ready.get(key)
	if (!preparing) {
		preparing = configureWindowsSandbox(bootstrap, cwd, profile, signal)
		ready.set(key, preparing)
		preparing.catch(() => {
			if (ready.get(key) === preparing) ready.delete(key)
		})
	}
	await preparing
	signal?.throwIfAborted()
}

async function configureWindowsSandbox(
	bootstrap: SandboxedCommand,
	cwd: string,
	profile: string,
	signal?: AbortSignal,
) {
	try {
		const options = {
			cwd,
			windowsHide: true,
			stdin: "ignore" as const,
			shell: false as const,
			cancelSignal: signal,
			timeout: 120_000,
		}
		let initialized = false
		try {
			await fs.access(path.join(bootstrap.env.CODEX_HOME!, ".sandbox", "setup_marker.json"))
			initialized = true
		} catch {
			/* The native bootstrap owns the one-time Windows account and credential setup. */
		}
		if (!initialized) {
			bootstrap.assertScope()
			await execa(bootstrap.executable, [...bootstrap.args], { ...options, env: bootstrap.env })
		}
		const powershell = path.join(
			process.env.SystemRoot || "C:\\Windows",
			"System32",
			"WindowsPowerShell",
			"v1.0",
			"powershell.exe",
		)
		await execa(
			powershell,
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-EncodedCommand",
				Buffer.from(windowsProfileReadScript(profile), "utf16le").toString("base64"),
			],
			// A VS Code instance launched from PowerShell 7 can inherit incompatible module paths.
			// This fixed setup script needs only the Windows PowerShell built-ins.
			{ ...options, env: { PSModulePath: path.join(path.dirname(powershell), "Modules") } },
		)
	} catch (error) {
		throw new Error(t("common:commandSandbox.unavailable"), { cause: error })
	}
}
