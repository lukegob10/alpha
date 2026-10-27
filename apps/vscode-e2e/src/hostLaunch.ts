import { spawn } from "child_process"
import * as path from "node:path"
import { downloadAndUnzipVSCode, type TestOptions } from "@vscode/test-electron"
import { TestRunError, type TestRunFailureCode } from "./runFailure"
import { terminateOwnedProcess } from "./campaign/ownedProcess"
import {
	watchLiveHost,
	LIVE_HOST_CLOSE_TIMEOUT_MS,
	type LiveHostExpected,
	type HostLaunchKind,
} from "./liveHostProtocol"

export type HostLaunchOptions = Omit<TestOptions, "extensionTestsPath"> &
	(
		| { launchKind?: "extension-test"; extensionTestsPath: string }
		| { launchKind: "development-sidecar"; extensionTestsPath?: never }
	) & {
		liveHost?: {
			artifactsDir: string
			expected: LiveHostExpected
			interactiveSetup?: boolean
			executionTimeoutMs?: number
		}
	}

/** Root close and tree cleanup remain distinct; unknown cleanup must retain the profile lease. */
export class HostLaunchCancelledError extends TestRunError {
	constructor(
		readonly hostExitCode?: number,
		readonly cleanupVerified = false,
		readonly hostExitObserved = hostExitCode !== undefined,
	) {
		super("host-cancelled", "The owned VS Code launch was cancelled")
	}
}

export class HostLaunchFailureError extends TestRunError {
	constructor(
		code: TestRunFailureCode,
		readonly hostExitObserved: boolean,
		readonly cleanupVerified: boolean,
	) {
		super(code, "The owned VS Code launch did not complete")
	}
}

/** Keep download/version resolution in vscode-test; never pass explicit test paths through a Windows shell. */
export async function launchExtensionHost(
	options: HostLaunchOptions,
	onSpawn?: (pid: number) => void,
	signal?: AbortSignal,
): Promise<number> {
	if (signal?.aborted) throw new HostLaunchCancelledError()
	const launchKind: HostLaunchKind = options.launchKind ?? "extension-test"
	if (
		!["extension-test", "development-sidecar"].includes(launchKind) ||
		(launchKind === "development-sidecar"
			? options.extensionTestsPath !== undefined
			: !options.extensionTestsPath) ||
		options.launchArgs?.some((argument) => /^--extensionTestsPath(?:=|$)/i.test(argument))
	) {
		throw new TestRunError("invalid-options", "Invalid extension host launch mode")
	}
	const extensionTestsEnv = { ...process.env, ...options.extensionTestsEnv }
	const userHome = extensionTestsEnv.ALPHA_E2E_USER_HOME
	if (userHome !== undefined) {
		if (!path.isAbsolute(userHome) || userHome.includes("\0")) {
			throw new TestRunError("invalid-options", "ALPHA_E2E_USER_HOME must be an absolute path")
		}
		// Keep package-manager configuration in the runner's home; isolate only the GUI process.
		extensionTestsEnv[process.platform === "win32" ? "USERPROFILE" : "HOME"] = userHome
	}
	const executable = options.vscodeExecutablePath ?? (await downloadAndUnzipVSCode(options))
	if (signal?.aborted) throw new HostLaunchCancelledError()
	const developments = Array.isArray(options.extensionDevelopmentPath)
		? options.extensionDevelopmentPath
		: [options.extensionDevelopmentPath]
	const args = [
		...(options.launchArgs ?? []),
		"--no-sandbox",
		"--disable-gpu-sandbox",
		"--disable-updates",
		"--skip-welcome",
		"--skip-release-notes",
		"--disable-workspace-trust",
		...(launchKind === "extension-test" ? [`--extensionTestsPath=${options.extensionTestsPath}`] : []),
		...developments.map((directory) => `--extensionDevelopmentPath=${directory}`),
	]
	// A GUI host must start the workbench, even when launched from an Electron Node process.
	delete extensionTestsEnv.ELECTRON_RUN_AS_NODE
	const child = spawn(executable, args, {
		shell: false,
		windowsHide: false,
		detached: process.platform !== "win32",
		// A retained unknown-close GUI must not keep the campaign runner's output pipes alive.
		// Normal-host diagnostics live in its owned receipts/profile logs, not raw console capture.
		stdio: launchKind === "development-sidecar" ? "ignore" : "inherit",
		env: extensionTestsEnv,
	})
	return new Promise<number>((resolve, reject) => {
		let settled = false
		let closed = false
		let monitor: { dispose(): void } | undefined
		let cleanupTimer: NodeJS.Timeout | undefined
		let failure: TestRunError | undefined
		let termination: Promise<{ cleanupVerified: boolean }> | undefined
		const cleanup = () => {
			monitor?.dispose()
			clearTimeout(cleanupTimer)
			signal?.removeEventListener("abort", cancelled)
		}
		const finishFailure = (hostExitObserved: boolean, cleanupVerified: boolean, code?: number) => {
			if (settled) return
			settled = true
			cleanup()
			child.unref()
			reject(
				failure?.code === "host-cancelled"
					? new HostLaunchCancelledError(code, cleanupVerified, hostExitObserved)
					: new HostLaunchFailureError(failure?.code ?? "host-failed", hostExitObserved, cleanupVerified),
			)
		}
		const fail = (error: TestRunError) => {
			if (settled || failure) return
			failure = error
			monitor?.dispose()
			cleanupTimer = setTimeout(() => finishFailure(closed, false), LIVE_HOST_CLOSE_TIMEOUT_MS)
			termination = terminateOwnedProcess(child, child.pid, () => closed, 1_000).catch(() => ({
				cleanupVerified: false,
			}))
		}
		const cancelled = () => fail(new TestRunError("host-cancelled", "The owned host launch was cancelled"))
		if (options.liveHost) {
			try {
				monitor = watchLiveHost(options.liveHost.artifactsDir, options.liveHost.expected, fail, {
					interactiveSetup: options.liveHost.interactiveSetup,
					executionTimeoutMs: options.liveHost.executionTimeoutMs,
				})
			} catch {
				fail(new TestRunError("host-completion-invalid", "Unable to observe live host receipts"))
			}
		}
		if (!settled) {
			signal?.addEventListener("abort", cancelled, { once: true })
			if (signal?.aborted) cancelled()
		}
		child.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code !== "ABORT_ERR") fail(new TestRunError("host-failed", "The VS Code process could not start"))
		})
		child.once("close", (code) => {
			closed = true
			if (settled) return
			if (failure) {
				void (async () => {
					const result = await termination
					const verified = result?.cleanupVerified === true
					finishFailure(true, verified, code ?? undefined)
				})()
			} else {
				settled = true
				cleanup()
				if (code === null)
					reject(new TestRunError("host-failed", "The VS Code process ended without an exit code"))
				else resolve(code)
			}
		})
		if (child.pid !== undefined) onSpawn?.(child.pid)
	})
}
