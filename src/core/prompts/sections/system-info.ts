import os from "os"
import osName from "os-name"

import { getShell } from "../../../utils/shell"

function getCommandSyntax(commandShell: string): string {
	const executable = commandShell.split(/[\\/]/).pop()?.toLowerCase()
	if (executable === "cmd.exe" || executable === "cmd") {
		return "\nCommand syntax: cmd.exe uses double quotes; single quotes are literal characters. Do not assume Unix head/tail are installed. Use exec_command output limits for bounded output and rg --files to discover actual filenames before reading them."
	}
	if (executable && /^(?:powershell|pwsh)(?:\.exe)?$/.test(executable)) {
		return "\nCommand syntax: use PowerShell syntax, Get-Content for files, and Select-Object -First for bounded pipelines; do not assume Unix head/tail are installed."
	}
	return ""
}

export function getSystemInfoSection(cwd: string, commandShell = getShell()): string {
	// windows-release (used by os-name) launches WMIC/PowerShell synchronously.
	// Prompt construction must not block checkpoint/process callbacks in the host.
	let osInfo: string
	try {
		osInfo = os.platform() === "win32" ? `Windows (kernel ${os.release()})` : osName()
	} catch (error) {
		// Keep prompt construction available when descriptive metadata is unavailable.
		const platform = os.platform()
		const release = os.release()
		osInfo = `${platform} ${release}`
	}

	let details = `====

SYSTEM INFORMATION

Operating System: ${osInfo}
Default Shell: ${commandShell}${getCommandSyntax(commandShell)}
Home Directory: ${os.homedir().toPosix()}
Current Workspace Directory: ${cwd.toPosix()}

The Current Workspace Directory is the active VS Code project directory, and is therefore the default directory for all tool operations. New terminals will be created in the current workspace directory, however if you change directories in a terminal it will then have a different working directory; changing directories in a terminal does not modify the workspace directory, because you do not have access to change the workspace directory. When the user initially gives you a task, a recursive list of all filepaths in the current workspace directory ('${cwd.toPosix()}') will be included in environment_details. This provides an overview of the project's file structure, offering key insights into the project from directory/file names (how developers conceptualize and organize their code) and file extensions (the language used). Stay within this workspace unless the user named a path outside it. Use a bounded exec_command inspection for folders; do not enumerate home or other outside directories on your own.`

	return details
}
