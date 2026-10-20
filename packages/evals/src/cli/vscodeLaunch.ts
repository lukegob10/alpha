import os from "node:os"
import path from "node:path"

export type IsolatedVscodeLaunch = {
	executablePath: string
	userDataDir: string
	extensionsDir: string
	sharedDataDir: string
	extensionDevelopmentPath: string
}

export function requireVscodeExecutablePath(value: string | undefined, platform = process.platform): string {
	const paths = platform === "win32" ? path.win32 : path.posix
	if (
		!value ||
		value.includes("\0") ||
		!paths.isAbsolute(value) ||
		(platform === "win32" && paths.extname(value).toLowerCase() !== ".exe")
	) {
		throw new Error("Local benchmarks require an absolute VS Code 1.138.0 executable in VSCODE_EXECUTABLE_PATH")
	}
	return value
}

export function vscodeLaunch(
	workspace: string,
	containerized: boolean,
	platform = process.platform,
	isolated?: IsolatedVscodeLaunch,
) {
	const args = ["--disable-workspace-trust", "-n", workspace]
	if (isolated) {
		if (containerized) throw new Error("Isolated local launch cannot replace the evaluator container host")
		const paths = platform === "win32" ? path.win32 : path.posix
		const executablePath = requireVscodeExecutablePath(isolated.executablePath, platform)
		for (const directory of [
			isolated.userDataDir,
			isolated.extensionsDir,
			isolated.sharedDataDir,
			isolated.extensionDevelopmentPath,
		]) {
			if (!directory || directory.includes("\0") || !paths.isAbsolute(directory))
				throw new Error("Isolated benchmark directories must be absolute paths")
		}
		return {
			command: executablePath,
			args: [
				`--user-data-dir=${isolated.userDataDir}`,
				`--extensions-dir=${isolated.extensionsDir}`,
				`--shared-data-dir=${isolated.sharedDataDir}`,
				`--extensionDevelopmentPath=${isolated.extensionDevelopmentPath}`,
				"--disable-updates",
				"--skip-welcome",
				"--skip-release-notes",
				...args,
			],
		}
	}
	if (!containerized) return { command: platform === "win32" ? "code.cmd" : "code", args }
	return {
		command: "xvfb-run",
		args: [
			"--auto-servernum",
			"--server-num=1",
			"code",
			"--wait",
			"--log",
			"trace",
			"--disable-gpu",
			"--disable-lcd-text",
			"--no-sandbox",
			"--user-data-dir",
			"/roo/.vscode",
			"--password-store=basic",
			...args,
		],
	}
}

export function evaluatorIpcEndpoint(
	runId: number,
	taskId: number,
	platform = process.platform,
	namespace?: string,
): string {
	if (namespace !== undefined && !/^[a-z0-9-]{1,32}$/i.test(namespace))
		throw new Error("Evaluator IPC namespace must be a bounded filename component")
	const name = `evals-${runId}-${taskId}${namespace ? `-${namespace}` : ""}.sock`
	return platform === "win32" ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), name)
}
