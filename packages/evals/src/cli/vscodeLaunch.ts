import os from "node:os"
import path from "node:path"

export function vscodeLaunch(workspace: string, containerized: boolean, platform = process.platform) {
	const args = ["--disable-workspace-trust", "-n", workspace]
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

export function evaluatorIpcEndpoint(runId: number, taskId: number, platform = process.platform): string {
	const name = `evals-${runId}-${taskId}.sock`
	return platform === "win32" ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), name)
}
