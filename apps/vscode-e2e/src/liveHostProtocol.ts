import * as fs from "node:fs/promises"
import { watch } from "node:fs"
import * as path from "node:path"
import { randomUUID } from "node:crypto"

import { readBounded, rejectSymlinkComponents, requireEvidenceRun } from "./evidence/paths"
import { TestRunError, TEST_RUN_FAILURE_CODES, type TestRunFailureCode } from "./runFailure"

export type HostLaunchKind = "extension-test" | "development-sidecar"
export const LIVE_HOST_STARTED = "live-host-started.json"
export const LIVE_HOST_COMPLETION = "host-completion.json"
export const LIVE_HOST_STARTUP_TIMEOUT_MS = 60_000
export const LIVE_HOST_CLOSE_TIMEOUT_MS = 10_000

export type LiveHostExpected = {
	runId: string
	nonce: string
	actualVSCodeVersion: string
}

export type LiveHostReceipt = LiveHostExpected & {
	schemaVersion: 1
	launchKind: "development-sidecar"
	pid: number
	ppid: number
	status: "started" | "passed" | "failed"
	failure?: TestRunFailureCode
}

export function validateLiveHostExpected(expected: LiveHostExpected): void {
	if (
		!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(expected.runId) ||
		!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(expected.nonce) ||
		!/^\d+\.\d+\.\d+$/.test(expected.actualVSCodeVersion)
	) {
		throw new TestRunError("invalid-options", "Invalid live host correlation")
	}
}

export function validateLiveHostReceipt(
	value: unknown,
	expected: LiveHostExpected,
	status: "started" | "terminal",
	identity?: Pick<LiveHostReceipt, "pid" | "ppid">,
): LiveHostReceipt {
	validateLiveHostExpected(expected)
	const candidate = value as Partial<LiveHostReceipt> | null
	if (
		!candidate ||
		typeof candidate !== "object" ||
		Array.isArray(candidate) ||
		Object.keys(candidate).some(
			(key) =>
				![
					"schemaVersion",
					"launchKind",
					"runId",
					"nonce",
					"actualVSCodeVersion",
					"pid",
					"ppid",
					"status",
					"failure",
				].includes(key),
		) ||
		candidate.schemaVersion !== 1 ||
		candidate.launchKind !== "development-sidecar" ||
		candidate.runId !== expected.runId ||
		candidate.nonce !== expected.nonce ||
		candidate.actualVSCodeVersion !== expected.actualVSCodeVersion ||
		!Number.isSafeInteger(candidate.pid) ||
		Number(candidate.pid) <= 0 ||
		!Number.isSafeInteger(candidate.ppid) ||
		Number(candidate.ppid) <= 0 ||
		(status === "started"
			? candidate.status !== "started"
			: !["passed", "failed"].includes(candidate.status ?? "")) ||
		(candidate.status === "failed"
			? !TEST_RUN_FAILURE_CODES.includes(candidate.failure as TestRunFailureCode)
			: candidate.failure !== undefined) ||
		(identity && (candidate.pid !== identity.pid || candidate.ppid !== identity.ppid))
	) {
		throw new TestRunError("host-completion-invalid", "Live host receipt does not match this launch")
	}
	return candidate as LiveHostReceipt
}

export async function readLiveHostReceipt(
	artifactsDir: string,
	file: typeof LIVE_HOST_STARTED | typeof LIVE_HOST_COMPLETION,
	expected: LiveHostExpected,
	identity?: Pick<LiveHostReceipt, "pid" | "ppid">,
): Promise<LiveHostReceipt> {
	try {
		return validateLiveHostReceipt(
			JSON.parse((await readBounded(path.join(artifactsDir, file), 4096)).toString("utf8")),
			expected,
			file === LIVE_HOST_STARTED ? "started" : "terminal",
			identity,
		)
	} catch (error) {
		if (error instanceof TestRunError) throw error
		throw new TestRunError(
			(error as NodeJS.ErrnoException).code === "ENOENT" ? "host-completion-missing" : "host-completion-invalid",
			"Live host receipt is missing or invalid",
		)
	}
}

export async function writeLiveHostReceipt(artifactsDir: string, receipt: LiveHostReceipt): Promise<void> {
	if (path.resolve(artifactsDir) !== (await requireEvidenceRun(path.dirname(artifactsDir), receipt.runId)))
		throw new TestRunError("invalid-options", "Mismatched receipt directory")
	validateLiveHostReceipt(receipt, receipt, receipt.status === "started" ? "started" : "terminal")
	const file = receipt.status === "started" ? LIVE_HOST_STARTED : LIVE_HOST_COMPLETION
	const target = path.join(artifactsDir, file)
	const temporary = `${target}.${randomUUID()}.tmp`
	try {
		await fs.writeFile(temporary, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 })
		// Atomic no-replace publication: another activation cannot replace a terminal receipt.
		await fs.link(temporary, target)
	} finally {
		await fs.unlink(temporary).catch(() => undefined)
	}
}

/** Materialize one fixed extension manifest around the existing compiled suite, never an arbitrary entry path. */
export async function prepareLiveSidecar(): Promise<string> {
	const root = path.resolve(__dirname)
	const template = path.resolve(root, "../live-sidecar.package.json")
	const manifest = JSON.parse((await readBounded(template, 4096)).toString("utf8"))
	if (
		!manifest ||
		typeof manifest !== "object" ||
		Array.isArray(manifest) ||
		Object.keys(manifest).some(
			(key) =>
				![
					"name",
					"displayName",
					"version",
					"publisher",
					"private",
					"engines",
					"activationEvents",
					"main",
				].includes(key),
		) ||
		manifest.name !== "alpha-live-e2e-sidecar" ||
		manifest.publisher !== "alpha-code-e2e" ||
		manifest.main !== "./liveRunnerExtension.js" ||
		manifest.engines?.vscode !== "^1.122.1" ||
		Object.keys(manifest.engines).length !== 1 ||
		manifest.version !== "1.0.0" ||
		manifest.private !== true ||
		JSON.stringify(manifest.activationEvents) !== '["onStartupFinished"]'
	) {
		throw new TestRunError("invalid-options", "Invalid fixed sidecar manifest")
	}
	await rejectSymlinkComponents(root)
	await readBounded(path.join(root, "liveRunnerExtension.js"), 128 * 1024)
	const target = path.join(root, "package.json")
	await rejectSymlinkComponents(target)
	const serialized = JSON.stringify(manifest, null, 2) + "\n"
	try {
		if ((await readBounded(target, 4096)).toString("utf8") === serialized) return root
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
	const temporary = `${target}.${randomUUID()}.tmp`
	try {
		await fs.writeFile(temporary, serialized, { flag: "wx" })
		await fs.rename(temporary, target)
	} finally {
		await fs.unlink(temporary).catch(() => undefined)
	}
	return root
}

/** Observe only two atomic run receipts. Idle interactive setup has no timer after startup. */
export function watchLiveHost(
	artifactsDir: string,
	expected: LiveHostExpected,
	onFailure: (error: TestRunError) => void,
	dependencies: {
		readReceipt?: typeof readLiveHostReceipt
		watchFiles?: (onFile: (file: string) => void, onError: () => void) => { dispose(): void }
	} = {},
): { dispose(): void } {
	let disposed = false
	let checking = false
	let pending = false
	let started: LiveHostReceipt | undefined
	let completed = false
	let watcher: { dispose(): void } | undefined
	const dispose = () => {
		if (disposed) return
		disposed = true
		clearTimeout(timer)
		watcher?.dispose()
	}
	const fail = (error: TestRunError) => {
		if (disposed) return
		dispose()
		onFailure(error)
	}
	const readReceipt = dependencies.readReceipt ?? readLiveHostReceipt
	let timer: NodeJS.Timeout | undefined = setTimeout(
		() => fail(new TestRunError("host-startup-timeout", "Live sidecar did not start")),
		LIVE_HOST_STARTUP_TIMEOUT_MS,
	)
	const check = async () => {
		if (disposed) return
		if (checking) {
			pending = true
			return
		}
		checking = true
		try {
			if (!started) {
				started = await readReceipt(artifactsDir, LIVE_HOST_STARTED, expected)
				if (disposed) return
				clearTimeout(timer)
				timer = undefined
			}
			if (!completed) {
				await readReceipt(artifactsDir, LIVE_HOST_COMPLETION, expected, started)
				if (disposed) return
				completed = true
				timer = setTimeout(
					() => fail(new TestRunError("host-close-timeout", "Live host did not close after completion")),
					LIVE_HOST_CLOSE_TIMEOUT_MS,
				)
			}
		} catch (error) {
			if (!disposed && (!(error instanceof TestRunError) || error.code !== "host-completion-missing"))
				fail(new TestRunError("host-completion-invalid", "Invalid live host receipt"))
		} finally {
			checking = false
			if (pending && !disposed) {
				pending = false
				void check()
			}
		}
	}
	const onFile = (file: string) => {
		if (file === LIVE_HOST_STARTED || file === LIVE_HOST_COMPLETION) void check()
	}
	const onError = () => fail(new TestRunError("host-completion-invalid", "Live receipt watch failed"))
	try {
		if (dependencies.watchFiles) watcher = dependencies.watchFiles(onFile, onError)
		else {
			const files = watch(artifactsDir, (_event, file) => {
				if (file) onFile(file)
			})
			files.on("error", onError)
			watcher = { dispose: () => files.close() }
		}
		// A test seam (or future watcher adapter) may report failure synchronously while registering.
		if (disposed) watcher.dispose()
	} catch (error) {
		dispose()
		throw error
	}
	void check()
	return { dispose }
}
