import { spawn } from "child_process"
import { downloadAndUnzipVSCode, type TestOptions } from "@vscode/test-electron"
import { TestRunError } from "./runFailure"
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
	) & { liveHost?: { artifactsDir: string; expected: LiveHostExpected } }

/** A numeric cancellation exit is published only after close; a bounded unknown close retains ownership. */
export class HostLaunchCancelledError extends TestRunError {
	constructor(readonly hostExitCode?: number) {
		super("host-cancelled", "The owned VS Code launch was cancelled")
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
	const child = spawn(executable, args, {
		shell: false,
		windowsHide: false,
		// A retained unknown-close GUI must not keep the campaign runner's output pipes alive.
		// Normal-host diagnostics live in its owned receipts/profile logs, not raw console capture.
		stdio: launchKind === "development-sidecar" ? "ignore" : "inherit",
		env: { ...process.env, ...options.extensionTestsEnv },
		signal,
	})
	return new Promise<number>((resolve, reject) => {
		let settled = false
		let monitor: { dispose(): void } | undefined
		let cancelTimer: NodeJS.Timeout | undefined
		const cleanup = () => {
			monitor?.dispose()
			clearTimeout(cancelTimer)
			signal?.removeEventListener("abort", cancelled)
		}
		const fail = (error: Error) => {
			if (settled) return
			settled = true
			cleanup()
			// Unknown close is not success. Leave the window/profile lease intact for inspection.
			child.unref()
			reject(error)
		}
		const cancelled = () => {
			monitor?.dispose()
			cancelTimer = setTimeout(() => fail(new HostLaunchCancelledError()), LIVE_HOST_CLOSE_TIMEOUT_MS)
		}
		if (options.liveHost) {
			try {
				monitor = watchLiveHost(options.liveHost.artifactsDir, options.liveHost.expected, fail)
			} catch {
				fail(new TestRunError("host-completion-invalid", "Unable to observe live host receipts"))
			}
		}
		if (!settled) {
			signal?.addEventListener("abort", cancelled, { once: true })
			if (signal?.aborted) cancelled()
		}
		child.once("error", (error: NodeJS.ErrnoException) => {
			// Node emits AbortError before close. That event is not evidence that a host has exited.
			if (error.code !== "ABORT_ERR") fail(new TestRunError("host-failed", "The VS Code process could not start"))
		})
		child.once("close", (code) => {
			if (settled) return
			settled = true
			cleanup()
			if (signal?.aborted) reject(new HostLaunchCancelledError(code ?? undefined))
			else if (code === null)
				reject(new TestRunError("host-failed", "The VS Code process ended without an exit code"))
			else resolve(code)
		})
		if (child.pid !== undefined) onSpawn?.(child.pid)
	})
}
