import path from "path"

/** Host-owned observer metadata for one physical execution; never populated from tool arguments. */
export interface PytestVerificationLaunch {
	readonly executionId: string
	readonly moduleName: string
	readonly moduleDirectory: string
	readonly reportPath: string
}

export type PytestVerificationTerminalLaunch =
	| {
			readonly available: true
			readonly commandToExecute: string
			readonly helper?: { readonly path: string; readonly content: string }
	  }
	| { readonly available: false; readonly reason: string }

function validLaunch(launch: PytestVerificationLaunch, platform: NodeJS.Platform): boolean {
	const paths = platform === "win32" ? path.win32 : path.posix
	return (
		typeof launch.executionId === "string" &&
		launch.executionId.length > 0 &&
		launch.executionId.length <= 256 &&
		!/[\0\r\n]/.test(launch.executionId) &&
		/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(launch.moduleName) &&
		[launch.moduleDirectory, launch.reportPath].every(
			(value) =>
				typeof value === "string" &&
				value.length <= 4_096 &&
				!/[\0\r\n]/.test(value) &&
				paths.isAbsolute(value),
		) &&
		!launch.moduleDirectory.includes(paths.delimiter)
	)
}

function appendEnvironmentValue(previous: string | undefined, value: string, delimiter: string): string {
	return previous ? `${previous}${delimiter}${value}` : value
}

/** Creates a subprocess-only environment. Existing pytest selection and plugin options remain intact. */
export function createPytestVerificationEnvironment(
	launch: PytestVerificationLaunch,
	environment: Readonly<NodeJS.ProcessEnv>,
	platform: NodeJS.Platform = process.platform,
): Readonly<NodeJS.ProcessEnv> {
	if (!validLaunch(launch, platform)) throw new Error("Invalid pytest verification launch descriptor")
	const result = { ...environment }
	const append = (name: string, value: string, delimiter: string) => {
		// Windows environment names are case insensitive, including inherited mixed-case names.
		const key =
			platform === "win32"
				? (Object.keys(result).find((candidate) => candidate.toUpperCase() === name) ?? name)
				: name
		result[key] = appendEnvironmentValue(result[key], value, delimiter)
	}
	append("PYTHONPATH", launch.moduleDirectory, platform === "win32" ? ";" : ":")
	append("PYTEST_PLUGINS", launch.moduleName, ",")
	return Object.freeze(result)
}

function quotePosix(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`
}

function quotePowerShell(value: string): string {
	return `'${value.replace(/'/g, "''")}'`
}

/**
 * Call only for an already admitted, parsed simple pytest command. Keep that original command in
 * task evidence and process.command; this transport string belongs only to the terminal adapter.
 * VS Code 1.122.1 TerminalState.shell reports the current shell, including a detected subshell.
 */
export function buildPytestVerificationTerminalLaunch(
	command: string,
	launch: PytestVerificationLaunch,
	shell: string | undefined,
	platform: NodeJS.Platform = process.platform,
): PytestVerificationTerminalLaunch {
	if (!validLaunch(launch, platform) || !command || command.length > 4_096 || /[\0\r\n]/.test(command)) {
		return {
			available: false,
			reason: "Pytest verification instrumentation requires bounded host paths and a simple command.",
		}
	}
	if (shell === "bash" || shell === "sh" || shell === "zsh" || shell === "gitbash") {
		const delimiter = platform === "win32" ? ";" : ":"
		return {
			available: true,
			// The subshell retains shell configuration and functions, scopes the overlay, and
			// returns the original command's status without a cleanup command replacing it.
			commandToExecute: `(PYTHONPATH="\${PYTHONPATH:+\${PYTHONPATH}${delimiter}}"${quotePosix(launch.moduleDirectory)} PYTEST_PLUGINS="\${PYTEST_PLUGINS:+\${PYTEST_PLUGINS},}"${quotePosix(launch.moduleName)} ${command})`,
		}
	}
	if (shell === "pwsh" || shell === "powershell") {
		const paths = platform === "win32" ? path.win32 : path.posix
		const helperPath = paths.join(launch.moduleDirectory, "launch.ps1")
		return {
			available: true,
			commandToExecute: `& ${quotePowerShell(helperPath)}`,
			helper: {
				path: helperPath,
				// An invoked script file provides the exit boundary; an inline script block's
				// exit can terminate the user's shell. Do not bypass script execution policy.
				content: [
					// Windows PowerShell 5.1 reads BOM-less source as ANSI, corrupting Unicode paths and arguments.
					"\uFEFF$alphaPytestHadPath = Test-Path -LiteralPath Env:PYTHONPATH",
					"$alphaPytestHadPlugins = Test-Path -LiteralPath Env:PYTEST_PLUGINS",
					"$alphaPytestPreviousPath = [Environment]::GetEnvironmentVariable('PYTHONPATH', 'Process')",
					"$alphaPytestPreviousPlugins = [Environment]::GetEnvironmentVariable('PYTEST_PLUGINS', 'Process')",
					"try {",
					`    $alphaPytestPath = ${quotePowerShell(launch.moduleDirectory)}`,
					"    if ($alphaPytestPreviousPath) { $alphaPytestPath = $alphaPytestPreviousPath + [IO.Path]::PathSeparator + $alphaPytestPath }",
					`    $alphaPytestPlugins = ${quotePowerShell(launch.moduleName)}`,
					"    if ($alphaPytestPreviousPlugins) { $alphaPytestPlugins = $alphaPytestPreviousPlugins + ',' + $alphaPytestPlugins }",
					"    [Environment]::SetEnvironmentVariable('PYTHONPATH', $alphaPytestPath, 'Process')",
					"    [Environment]::SetEnvironmentVariable('PYTEST_PLUGINS', $alphaPytestPlugins, 'Process')",
					`    ${command}`,
					"    $alphaPytestSucceeded = $?",
					// Never initialize a local LASTEXITCODE: it shadows the native command's update.
					"    $alphaPytestExitCode = $LASTEXITCODE",
					"    if (-not $alphaPytestSucceeded -and -not $alphaPytestExitCode) { $alphaPytestExitCode = 1 }",
					"} finally {",
					"    if ($alphaPytestHadPath) { [Environment]::SetEnvironmentVariable('PYTHONPATH', $alphaPytestPreviousPath, 'Process') } elseif (Test-Path -LiteralPath Env:PYTHONPATH) { Remove-Item -LiteralPath Env:PYTHONPATH }",
					"    if ($alphaPytestHadPlugins) { [Environment]::SetEnvironmentVariable('PYTEST_PLUGINS', $alphaPytestPreviousPlugins, 'Process') } elseif (Test-Path -LiteralPath Env:PYTEST_PLUGINS) { Remove-Item -LiteralPath Env:PYTEST_PLUGINS }",
					"}",
					"exit $alphaPytestExitCode",
					"",
				].join("\n"),
			},
		}
	}
	return {
		available: false,
		reason: "Pytest verification scope is unavailable because the active terminal shell is unsupported or unidentified. Use a detected PowerShell, bash, zsh, or sh terminal to obtain verification evidence.",
	}
}
