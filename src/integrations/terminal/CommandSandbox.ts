import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import os from "node:os"
import { isPathWithinRoot, resolvePathWithExistingAncestor } from "../../core/tools/pathSafety"
import { ensureSandboxRuntime } from "./SandboxRuntime"

// Windows can permit opening a file while denying ancestor metadata enumeration.
// Node's JavaScript realpath implementation walks those ancestors; its native implementation
// resolves the already-authorized target by handle. No permissions or path scope are changed.
const WINDOWS_NODE_PRELOAD = `import fs from 'node:fs';const original=fs.realpathSync;fs.realpathSync=Object.assign(function(value,options){try{return original(value,options)}catch(error){if(error?.syscall!=='lstat'||!['EPERM','EACCES'].includes(error.code))throw error;try{return original.native(value,options)}catch{throw error}}},{native:original.native});`

export function sandboxNodeOptions(existing = process.env.NODE_OPTIONS): string | undefined {
	if (process.platform !== "win32") return existing
	return [
		existing,
		"--preserve-symlinks-main",
		`--import=data:text/javascript,${encodeURIComponent(WINDOWS_NODE_PRELOAD)}`,
	]
		.filter(Boolean)
		.join(" ")
}

export interface SandboxedCommand {
	readonly executable: string
	readonly args: readonly string[]
	readonly env: Readonly<NodeJS.ProcessEnv>
	assertScope(): void
}

export interface CommandSandboxOptions {
	storagePath: string
	workspaceRoots: readonly string[]
	cwd: string
	readOnly?: boolean
	signal?: AbortSignal
}

/** Setup belongs to the OS user, never to a project or task. Reuse an existing native Windows setup. */
export async function resolveSandboxHome(storage: string): Promise<string> {
	if (process.platform === "win32") {
		const existingHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
		if (path.isAbsolute(existingHome)) {
			try {
				await fs.access(path.join(existingHome, ".sandbox", "setup_marker.json"))
				return await fs.realpath(existingHome)
			} catch {
				/* Alpha performs one global setup when there is no existing native setup. */
			}
		}
	}
	return path.join(storage, "command-sandbox", "home")
}

/** An explicit managed policy prevents local runtime configuration from widening task authority. */
export function sandboxState(roots: readonly string[], cwd: string, scratch: string, readOnly = false) {
	return {
		permissionProfile: {
			type: "managed",
			file_system: {
				type: "restricted",
				entries: [
					{ path: { type: "special", value: { kind: "root" } }, access: "read" },
					...(!readOnly ? roots : []).map((root) => ({
						path: { type: "path", path: root },
						access: "write",
					})),
					...(!readOnly ? roots : [])
						.filter((root) => isPathWithinRoot(root, path.join(root, ".git")))
						.map((root) => ({ path: { type: "path", path: path.join(root, ".git") }, access: "write" })),
					{ path: { type: "path", path: scratch }, access: "write" },
					// Keep harness configuration protected inside an otherwise writable root.
					...roots.flatMap((root) =>
						[".agents", ".codex"].map((name) => ({
							path: { type: "path", path: path.join(root, name) },
							access: "read",
						})),
					),
				],
			},
			network: "enabled",
		},
		sandboxCwd: pathToFileURL(cwd).href,
		useLegacyLandlock: false,
	}
}

export function shellInvocation(command: string, shell: string, platform = process.platform): string[] {
	const name = (platform === "win32" ? path.win32 : path.posix)
		.basename(shell)
		.toLowerCase()
		.replace(/\.exe$/, "")
	if (name === "powershell" || name === "pwsh")
		return [
			shell,
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
			Buffer.from(command, "utf16le").toString("base64"),
		]
	if (platform === "win32" && name === "cmd") {
		// cmd.exe does not use CommandLineToArgvW escaping. Pass its original interactive
		// command line through an encoded, fixed launcher, entirely inside the sandbox.
		// User text and the shell path are data, never interpolated as PowerShell code.
		const decode = (value: string) =>
			`[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value).toString("base64")}'))`
		const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';try{$s=[Diagnostics.ProcessStartInfo]::new();$s.FileName=${decode(shell)};$s.Arguments='/d /s /c "'+${decode(command)}+'"';$s.UseShellExecute=$false;$s.CreateNoWindow=$true;$s.RedirectStandardInput=$true;$s.RedirectStandardOutput=$true;$s.RedirectStandardError=$true;$p=[Diagnostics.Process]::Start($s);$p.StandardInput.Close();$o=$p.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput());$e=$p.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError());$p.WaitForExit();$null=$o.GetAwaiter().GetResult();$null=$e.GetAwaiter().GetResult();exit $p.ExitCode}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}`
		return shellInvocation(
			script,
			path.win32.join(
				process.env.SystemRoot || "C:\\Windows",
				"System32",
				"WindowsPowerShell",
				"v1.0",
				"powershell.exe",
			),
			platform,
		)
	}
	return [shell, "-c", command]
}

/** The returned launcher must be spawned with shell:false; the command is only an inner-shell argument. */
export async function prepareSandboxedCommand(
	options: CommandSandboxOptions,
	invocation: readonly string[],
): Promise<SandboxedCommand> {
	options.signal?.throwIfAborted()
	if (!path.isAbsolute(options.storagePath)) throw new Error("Command sandbox storage is unavailable.")
	if (!options.workspaceRoots.length || !invocation.length)
		throw new Error("Command sandbox requires a workspace scope.")
	const roots = await Promise.all(options.workspaceRoots.map((root) => fs.realpath(root)))
	const cwd = await fs.realpath(options.cwd)
	const intendedStorage = resolvePathWithExistingAncestor(options.storagePath)
	// A workspace containing the installer or its credentials would let a command replace its own guard.
	if (roots.some((root) => isPathWithinRoot(root, intendedStorage))) {
		throw new Error("Command sandbox storage must be outside the task workspace.")
	}
	await fs.mkdir(options.storagePath, { recursive: true })
	const storage = await fs.realpath(options.storagePath)
	// VS Code lowercases Windows drive letters, while native realpath may preserve their casing.
	if (path.relative(storage, intendedStorage) !== "")
		throw new Error("Command sandbox storage identity changed during setup.")
	const runtimeHome = await resolveSandboxHome(storage)
	if (roots.some((root) => isPathWithinRoot(root, runtimeHome))) {
		throw new Error("Command sandbox setup must be outside the task workspace.")
	}
	const runtime = await ensureSandboxRuntime(storage, options.signal)
	const scopeId = createHash("sha256")
		.update(JSON.stringify([...roots].sort()))
		.digest("hex")
	const scratch = path.join(storage, "command-sandbox", "scratch", scopeId)
	await fs.mkdir(scratch, { recursive: true })
	await fs.mkdir(runtimeHome, { recursive: true })
	const gitEnvironment: NodeJS.ProcessEnv = {}
	if (process.platform === "win32") {
		// The native sandbox uses a separate Windows identity. Trust only this task's repositories,
		// in process-local Git configuration; never change the user's global safe.directory setting.
		const count = Number(process.env.GIT_CONFIG_COUNT ?? 0)
		if (!Number.isSafeInteger(count) || count < 0 || count > 128)
			throw new Error("Invalid inherited Git configuration count.")
		const directories = roots.flatMap((root) => [root.replace(/\\/g, "/"), `${root.replace(/\\/g, "/")}/*`])
		directories.forEach((directory, index) => {
			gitEnvironment[`GIT_CONFIG_KEY_${count + index}`] = "safe.directory"
			gitEnvironment[`GIT_CONFIG_VALUE_${count + index}`] = directory
		})
		gitEnvironment.GIT_CONFIG_COUNT = String(count + directories.length)
	}
	options.signal?.throwIfAborted()
	return {
		assertScope: () => {
			options.signal?.throwIfAborted()
			const identities = [
				...options.workspaceRoots.map((root, index) => [root, roots[index]]),
				[options.cwd, cwd],
				[options.storagePath, storage],
			]
			if (
				identities.some(
					([original, canonical]) =>
						path.relative(resolvePathWithExistingAncestor(original), canonical) !== "",
				)
			) {
				throw new Error("Command workspace identity changed before execution.")
			}
		},
		executable: runtime,
		args: [
			"sandbox",
			"--sandbox-state-json",
			JSON.stringify(sandboxState(roots, cwd, scratch, options.readOnly)),
			"-c",
			'windows.sandbox="elevated"',
			"-c",
			"windows.sandbox_private_desktop=true",
			"-c",
			'shell_environment_policy={inherit="all",ignore_default_excludes=true,exclude=[],include_only=[],set={}}',
			"--",
			...invocation,
		],
		env: {
			...gitEnvironment,
			NODE_OPTIONS: sandboxNodeOptions(),
			CODEX_HOME: runtimeHome,
			TMPDIR: scratch,
			TMP: scratch,
			TEMP: scratch,
			XDG_CACHE_HOME: scratch,
			npm_config_cache: path.join(scratch, "npm"),
			PIP_CACHE_DIR: path.join(scratch, "pip"),
			PYTHONDONTWRITEBYTECODE: "1",
		},
	}
}
