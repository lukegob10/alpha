import * as vscode from "vscode"
import fs from "fs/promises"
import { constants } from "fs"
import type { CommandShellLaunch } from "../integrations/terminal/types"
import { userInfo } from "os"
import * as path from "path"

// Security: Allowlist of approved shell executables to prevent arbitrary command execution
const SHELL_ALLOWLIST = new Set<string>([
	// Windows PowerShell variants
	"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
	"C:\\Program Files\\PowerShell\\7\\pwsh.exe",
	"C:\\Program Files\\PowerShell\\6\\pwsh.exe",
	"C:\\Program Files\\PowerShell\\5\\pwsh.exe",

	// Windows Command Prompt
	"C:\\Windows\\System32\\cmd.exe",

	// Windows WSL
	"C:\\Windows\\System32\\wsl.exe",

	// Git Bash on Windows
	"C:\\Program Files\\Git\\bin\\bash.exe",
	"C:\\Program Files\\Git\\usr\\bin\\bash.exe",
	"C:\\Program Files (x86)\\Git\\bin\\bash.exe",
	"C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",

	// MSYS2/MinGW/Cygwin on Windows
	"C:\\msys64\\usr\\bin\\bash.exe",
	"C:\\msys32\\usr\\bin\\bash.exe",
	"C:\\MinGW\\msys\\1.0\\bin\\bash.exe",
	"C:\\cygwin64\\bin\\bash.exe",
	"C:\\cygwin\\bin\\bash.exe",

	// Unix/Linux/macOS - Bourne-compatible shells
	"/bin/sh",
	"/usr/bin/sh",
	"/bin/bash",
	"/usr/bin/bash",
	"/usr/local/bin/bash",
	"/opt/homebrew/bin/bash",
	"/opt/local/bin/bash",

	// Z Shell
	"/bin/zsh",
	"/usr/bin/zsh",
	"/usr/local/bin/zsh",
	"/opt/homebrew/bin/zsh",
	"/opt/local/bin/zsh",

	// Dash
	"/bin/dash",
	"/usr/bin/dash",

	// Ash
	"/bin/ash",
	"/usr/bin/ash",

	// C Shells
	"/bin/csh",
	"/usr/bin/csh",
	"/bin/tcsh",
	"/usr/bin/tcsh",
	"/usr/local/bin/tcsh",

	// Korn Shells
	"/bin/ksh",
	"/usr/bin/ksh",
	"/bin/ksh93",
	"/usr/bin/ksh93",
	"/bin/mksh",
	"/usr/bin/mksh",
	"/bin/pdksh",
	"/usr/bin/pdksh",

	// Fish Shell
	"/usr/bin/fish",
	"/usr/local/bin/fish",
	"/opt/homebrew/bin/fish",
	"/opt/local/bin/fish",

	// Modern shells
	"/usr/bin/elvish",
	"/usr/local/bin/elvish",
	"/usr/bin/xonsh",
	"/usr/local/bin/xonsh",
	"/usr/bin/nu",
	"/usr/local/bin/nu",
	"/usr/bin/nushell",
	"/usr/local/bin/nushell",
	"/usr/bin/ion",
	"/usr/local/bin/ion",

	// BusyBox
	"/bin/busybox",
	"/usr/bin/busybox",
])

const SHELL_PATHS = {
	// Windows paths
	POWERSHELL_7: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
	POWERSHELL_LEGACY: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
	CMD: "C:\\Windows\\System32\\cmd.exe",
	WSL_BASH: "/bin/bash",
	// Unix paths
	MAC_DEFAULT: "/bin/zsh",
	LINUX_DEFAULT: "/bin/bash",
	CSH: "/bin/csh",
	BASH: "/bin/bash",
	KSH: "/bin/ksh",
	SH: "/bin/sh",
	ZSH: "/bin/zsh",
	DASH: "/bin/dash",
	TCSH: "/bin/tcsh",
	FALLBACK: "/bin/sh",
} as const

interface MacTerminalProfile {
	path?: string | string[]
}

type MacTerminalProfiles = Record<string, MacTerminalProfile>

interface WindowsTerminalProfile {
	path?: string | string[]
	source?: "PowerShell" | "WSL"
}

type WindowsTerminalProfiles = Record<string, WindowsTerminalProfile>

interface LinuxTerminalProfile {
	path?: string | string[]
}

type LinuxTerminalProfiles = Record<string, LinuxTerminalProfile>

// -----------------------------------------------------
// 1) VS Code Terminal Configuration Helpers
// -----------------------------------------------------

function getWindowsTerminalConfig() {
	try {
		const config = vscode.workspace.getConfiguration("terminal.integrated")
		const defaultProfileName = config.get<string>("defaultProfile.windows")
		const profiles = config.get<WindowsTerminalProfiles>("profiles.windows") || {}
		return { defaultProfileName, profiles }
	} catch {
		return { defaultProfileName: null, profiles: {} as WindowsTerminalProfiles }
	}
}

function getMacTerminalConfig() {
	try {
		const config = vscode.workspace.getConfiguration("terminal.integrated")
		const defaultProfileName = config.get<string>("defaultProfile.osx")
		const profiles = config.get<MacTerminalProfiles>("profiles.osx") || {}
		return { defaultProfileName, profiles }
	} catch {
		return { defaultProfileName: null, profiles: {} as MacTerminalProfiles }
	}
}

function getLinuxTerminalConfig() {
	try {
		const config = vscode.workspace.getConfiguration("terminal.integrated")
		const defaultProfileName = config.get<string>("defaultProfile.linux")
		const profiles = config.get<LinuxTerminalProfiles>("profiles.linux") || {}
		return { defaultProfileName, profiles }
	} catch {
		return { defaultProfileName: null, profiles: {} as LinuxTerminalProfiles }
	}
}

// -----------------------------------------------------
// 2) Platform-Specific VS Code Shell Retrieval
// -----------------------------------------------------

/**
 * Normalizes a path that can be either a string or an array of strings.
 * If it's an array, returns the first element. Otherwise returns the string.
 */
function normalizeShellPath(path: string | string[] | undefined): string | null {
	if (!path) return null
	if (Array.isArray(path)) {
		return path.length > 0 ? path[0] : null
	}
	return path
}

/** Attempts to retrieve a shell path from VS Code config on Windows. */
function getWindowsShellFromVSCode(): string | null {
	const { defaultProfileName, profiles } = getWindowsTerminalConfig()
	if (!defaultProfileName) {
		return null
	}

	const profile = profiles[defaultProfileName]

	// If the profile name indicates PowerShell, do version-based detection.
	// In testing it was found these typically do not have a path, and this
	// implementation manages to deductively get the correct version of PowerShell
	if (defaultProfileName.toLowerCase().includes("powershell")) {
		const normalizedPath = normalizeShellPath(profile?.path)
		if (normalizedPath) {
			// If there's an explicit PowerShell path, return that
			return normalizedPath
		} else if (profile?.source === "PowerShell") {
			// If the profile is sourced from PowerShell, assume the newest
			return SHELL_PATHS.POWERSHELL_7
		}
		// Otherwise, assume legacy Windows PowerShell
		return SHELL_PATHS.POWERSHELL_LEGACY
	}

	// If there's a specific path, return that immediately
	const normalizedPath = normalizeShellPath(profile?.path)
	if (normalizedPath) {
		return normalizedPath
	}

	// If the profile indicates WSL
	if (profile?.source === "WSL" || defaultProfileName.toLowerCase().includes("wsl")) {
		return SHELL_PATHS.WSL_BASH
	}

	// If nothing special detected, we assume cmd
	return SHELL_PATHS.CMD
}

/** Attempts to retrieve a shell path from VS Code config on macOS. */
function getMacShellFromVSCode(): string | null {
	const { defaultProfileName, profiles } = getMacTerminalConfig()
	if (!defaultProfileName) {
		return null
	}

	const profile = profiles[defaultProfileName]
	return normalizeShellPath(profile?.path)
}

/** Attempts to retrieve a shell path from VS Code config on Linux. */
function getLinuxShellFromVSCode(): string | null {
	const { defaultProfileName, profiles } = getLinuxTerminalConfig()
	if (!defaultProfileName) {
		return null
	}

	const profile = profiles[defaultProfileName]
	return normalizeShellPath(profile?.path)
}

// -----------------------------------------------------
// 3) General Fallback Helpers
// -----------------------------------------------------

/**
 * Tries to get a user’s shell from os.userInfo() (works on Unix if the
 * underlying system call is supported). Returns null on error or if not found.
 */
function getShellFromUserInfo(): string | null {
	try {
		const { shell } = userInfo()
		return shell || null
	} catch {
		return null
	}
}

/** Returns the environment-based shell variable, or null if not set. */
function getShellFromEnv(): string | null {
	const { env } = process

	if (process.platform === "win32") {
		// On Windows, COMSPEC typically holds cmd.exe
		return env.COMSPEC || "C:\\Windows\\System32\\cmd.exe"
	}

	if (process.platform === "darwin") {
		// On macOS/Linux, SHELL is commonly the environment variable
		return env.SHELL || "/bin/zsh"
	}

	if (process.platform === "linux") {
		// On Linux, SHELL is commonly the environment variable
		return env.SHELL || "/bin/bash"
	}
	return null
}

// -----------------------------------------------------
// 4) Shell Validation Functions
// -----------------------------------------------------

/**
 * Validates if a shell path is in the allowlist to prevent arbitrary command execution
 */
function isShellAllowed(shellPath: string): boolean {
	if (!shellPath) return false

	const normalizedPath = path.normalize(shellPath)

	// Direct lookup first
	if (SHELL_ALLOWLIST.has(normalizedPath)) {
		return true
	}

	// On Windows, try case-insensitive comparison
	if (process.platform === "win32") {
		const lowerPath = normalizedPath.toLowerCase()
		for (const allowedPath of SHELL_ALLOWLIST) {
			if (allowedPath.toLowerCase() === lowerPath) {
				return true
			}
		}
	}

	return false
}

/**
 * Returns a safe fallback shell based on the platform
 */
function getSafeFallbackShell(): string {
	if (process.platform === "win32") {
		return SHELL_PATHS.CMD
	} else if (process.platform === "darwin") {
		return SHELL_PATHS.MAC_DEFAULT
	} else {
		return SHELL_PATHS.LINUX_DEFAULT
	}
}

// -----------------------------------------------------
// 5) Publicly Exposed Shell Getter
// -----------------------------------------------------

export function getShell(): string {
	let shell: string | null = null

	// 1. Check VS Code config first.
	if (process.platform === "win32") {
		// Special logic for Windows
		shell = getWindowsShellFromVSCode()
	} else if (process.platform === "darwin") {
		// macOS from VS Code
		shell = getMacShellFromVSCode()
	} else if (process.platform === "linux") {
		// Linux from VS Code
		shell = getLinuxShellFromVSCode()
	}

	// 2. If no shell from VS Code, try userInfo()
	if (!shell) {
		shell = getShellFromUserInfo()
	}

	// 3. If still nothing, try environment variable
	if (!shell) {
		shell = getShellFromEnv()
	}

	// 4. Finally, fall back to a default
	if (!shell) {
		shell = getSafeFallbackShell()
	}

	// 5. Validate the shell against allowlist
	if (!isShellAllowed(shell)) {
		shell = getSafeFallbackShell()
	}

	return shell
}

type CommandShellStartup = Pick<CommandShellLaunch, "shellPath" | "family" | "login">

export function getDefaultWindowsCommandShell(): CommandShellStartup | undefined {
	if (process.platform !== "win32") return undefined

	// Codex 88c58562 prefers pwsh when installed. Alpha defaults to the Windows inbox shell.
	const systemRoot = process.env.SystemRoot
	const shellPath =
		systemRoot && path.win32.isAbsolute(systemRoot)
			? path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
			: SHELL_PATHS.POWERSHELL_LEGACY
	return { shellPath, family: "powershell", login: false }
}

/** Reports the shell used by exec_command's selected terminal backend. */
export function getCommandShell(useExeca: boolean, execaShellPath?: string): string {
	if (useExeca && execaShellPath) return execaShellPath
	const windowsShell = getDefaultWindowsCommandShell()
	if (windowsShell) return windowsShell.shellPath
	return useExeca ? "/bin/sh" : vscode.env?.shell || getShell()
}

// These locations apply only to explicit selections; getShell's historical fallback remains unchanged.
const COMMAND_SHELL_PATHS = new Set([
	...SHELL_ALLOWLIST,
	"/usr/bin/pwsh",
	"/usr/local/bin/pwsh",
	"/opt/homebrew/bin/pwsh",
	"/opt/microsoft/powershell/7/pwsh",
])

function isCommandShellAllowed(shellPath: string, builtInWindowsShell?: string): boolean {
	return (
		isShellAllowed(shellPath) ||
		COMMAND_SHELL_PATHS.has(path.normalize(shellPath)) ||
		path.win32.normalize(shellPath).toLowerCase() === builtInWindowsShell?.toLowerCase()
	)
}

function commandShellFamily(shellPath: string): CommandShellLaunch["family"] | undefined {
	const name = path.win32
		.basename(path.posix.basename(shellPath))
		.replace(/\.exe$/i, "")
		.toLowerCase()
	if (name === "pwsh" || name === "powershell") return "powershell"
	if (name === "sh" || name === "bash" || name === "zsh" || name === "cmd") return name
	return undefined
}

async function commandShellBinaryIdentity(shellPath: string): Promise<string> {
	await fs.access(shellPath, process.platform === "win32" ? constants.F_OK : constants.X_OK)
	const stat = await fs.stat(shellPath)
	if (!stat.isFile()) throw new Error("The selected shell is not an executable file")
	return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs])
}

/**
 * Codex ac558e2a, core/src/shell.rs and handlers/unified_exec.rs (2026-11-03):
 * explicit interpreter/startup choices select argv. Omitted controls deliberately
 * retain Alpha's existing configured startup and never enter this path.
 */
export async function captureCommandShellLaunch(
	shell: unknown,
	login: unknown,
	fallbackShell: string,
): Promise<CommandShellLaunch | undefined> {
	if (shell == null && login == null) return undefined
	if (
		shell != null &&
		(typeof shell !== "string" || shell.length === 0 || shell.trim() !== shell || shell.includes("\0"))
	)
		throw new Error("shell must name an installed approved shell executable")
	if (login != null && typeof login !== "boolean") throw new Error("login must be a boolean")
	const requested = typeof shell === "string" ? shell : fallbackShell
	const family = commandShellFamily(requested)
	if (!family) throw new Error("The requested shell family is unsupported")
	const isBareName = path.win32.basename(requested) === requested && path.posix.basename(requested) === requested
	const builtInWindowsShell = getDefaultWindowsCommandShell()?.shellPath
	const approvedLocations = builtInWindowsShell
		? new Set([builtInWindowsShell, ...COMMAND_SHELL_PATHS])
		: COMMAND_SHELL_PATHS
	const candidates = isBareName
		? [...approvedLocations].filter(
				(candidate) =>
					path.isAbsolute(candidate) &&
					path
						.basename(candidate)
						.replace(/\.exe$/i, "")
						.toLowerCase() === requested.replace(/\.exe$/i, "").toLowerCase(),
			)
		: [requested]
	for (const candidate of candidates) {
		if (!isCommandShellAllowed(candidate, builtInWindowsShell)) continue
		try {
			const shellPath = await fs.realpath(candidate)
			if (!isCommandShellAllowed(shellPath, builtInWindowsShell)) continue
			const binaryIdentity = await commandShellBinaryIdentity(shellPath)
			const useLogin = typeof login === "boolean" ? login : true
			return Object.freeze({
				shellPath,
				family,
				login: useLogin,
				binaryIdentity,
				identity: JSON.stringify([shellPath, family, useLogin, binaryIdentity]),
			})
		} catch {
			// Try only the finite approved locations; never fall back to a different requested family.
		}
	}
	throw new Error("The selected shell is unavailable or outside the approved shell locations")
}

export async function assertCommandShellLaunchUnchanged(launch: CommandShellLaunch): Promise<void> {
	if ((await commandShellBinaryIdentity(launch.shellPath)) !== launch.binaryIdentity)
		throw new Error("The approved shell executable changed before command launch")
}

export function commandShellArgs(launch: CommandShellStartup, command: string): string[] {
	if (launch.family === "cmd") return ["/c", command]
	if (launch.family === "powershell") return [...(launch.login ? [] : ["-NoProfile"]), "-Command", command]
	return [launch.login ? "-lc" : "-c", command]
}

export function terminalShellArgs(launch: CommandShellStartup): string[] {
	if (launch.family === "cmd") return []
	if (launch.family === "powershell") return launch.login ? [] : ["-NoProfile"]
	return launch.login ? ["-l"] : []
}
