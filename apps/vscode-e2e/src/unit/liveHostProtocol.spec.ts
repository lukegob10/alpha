import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { setImmediate as nextTurn } from "node:timers/promises"

import { prepareEvidenceRun } from "../evidence/paths"
import {
	validateLiveHostReceipt,
	readLiveHostReceipt,
	writeLiveHostReceipt,
	LIVE_HOST_STARTED,
	LIVE_HOST_COMPLETION,
	type LiveHostReceipt,
	watchLiveHost,
	LIVE_HOST_STARTUP_TIMEOUT_MS,
	LIVE_HOST_CLOSE_TIMEOUT_MS,
} from "../liveHostProtocol"
import { TestRunError } from "../runFailure"

const expected = { runId: "normal-host-test", nonce: randomUUID(), actualVSCodeVersion: "1.122.1" }
const receipt: LiveHostReceipt = {
	...expected,
	schemaVersion: 1,
	launchKind: "development-sidecar",
	pid: 123,
	ppid: 45,
	status: "passed",
}

test("terminal receipts reject extra fields rather than retain arbitrary provider metadata", () => {
	assert.throws(() => validateLiveHostReceipt({ ...receipt, secret: "must-not-retain" }, expected, "terminal"), {
		code: "host-completion-invalid",
	})
})

test("receipts require exact run, nonce, host version, mode, status and process identity", () => {
	assert.deepEqual(validateLiveHostReceipt(receipt, expected, "terminal", receipt), receipt)
	for (const change of [
		{ runId: "stale-run" },
		{ nonce: randomUUID() },
		{ actualVSCodeVersion: "1.136.1" },
		{ launchKind: "extension-test" },
		{ schemaVersion: 2 },
		{ pid: 0 },
		{ ppid: 0 },
		{ pid: 999 },
		{ ppid: 999 },
		{ status: "started" },
		{ failure: "host-failed" },
		{ status: "failed" },
		{ status: "failed", failure: "raw-secret-error" },
	]) {
		assert.throws(() => validateLiveHostReceipt({ ...receipt, ...change }, expected, "terminal", receipt), {
			code: "host-completion-invalid",
		})
	}
	assert.equal(
		validateLiveHostReceipt({ ...receipt, status: "failed", failure: "host-failed" }, expected, "terminal").status,
		"failed",
	)
})

test("owned atomic receipts cannot be overwritten; missing or malformed completion never passes", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-live-receipts-"))
	try {
		const { artifactDirectory } = await prepareEvidenceRun({ artifactsRoot: root, runId: expected.runId })
		await assert.rejects(readLiveHostReceipt(artifactDirectory, LIVE_HOST_COMPLETION, expected), {
			code: "host-completion-missing",
		})
		await writeLiveHostReceipt(artifactDirectory, { ...receipt, status: "started" })
		await writeLiveHostReceipt(artifactDirectory, receipt)
		assert.deepEqual(await readLiveHostReceipt(artifactDirectory, LIVE_HOST_STARTED, expected), {
			...receipt,
			status: "started",
		})
		assert.deepEqual(await readLiveHostReceipt(artifactDirectory, LIVE_HOST_COMPLETION, expected, receipt), receipt)
		await assert.rejects(
			writeLiveHostReceipt(artifactDirectory, { ...receipt, status: "failed", failure: "host-failed" }),
		)
		assert.deepEqual(await readLiveHostReceipt(artifactDirectory, LIVE_HOST_COMPLETION, expected), receipt)
		await fs.writeFile(path.join(artifactDirectory, LIVE_HOST_COMPLETION), "{invalid")
		await assert.rejects(readLiveHostReceipt(artifactDirectory, LIVE_HOST_COMPLETION, expected), {
			code: "host-completion-invalid",
		})
		assert.equal(
			(await fs.readdir(artifactDirectory)).some((name) => name.endsWith(".tmp")),
			false,
		)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

function monitor() {
	const published = new Map<string, LiveHostReceipt>()
	const failures: string[] = []
	let event!: (file: string) => void
	let disposed = 0
	const session = watchLiveHost("unused-test-path", expected, (error) => failures.push(error.code), {
		watchFiles: (listener) => {
			event = listener
			return {
				dispose: () => {
					disposed++
				},
			}
		},
		readReceipt: async (_directory, file, request, identity) => {
			const value = published.get(file)
			if (!value) throw new TestRunError("host-completion-missing", "not published")
			return validateLiveHostReceipt(
				value,
				request,
				file === LIVE_HOST_STARTED ? "started" : "terminal",
				identity,
			)
		},
	})
	return {
		session,
		failures,
		published,
		event: (file: string) => event(file),
		disposed: () => disposed,
	}
}

test("startup absence times out once and releases its watcher", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] })
	const host = monitor()
	await nextTurn()
	context.mock.timers.tick(LIVE_HOST_STARTUP_TIMEOUT_MS)
	assert.deepEqual(host.failures, ["host-startup-timeout"])
	host.session.dispose()
	assert.equal(host.disposed(), 1)
})

test("interactive setup can remain idle indefinitely after startup; completed runs have a close deadline", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] })
	const host = monitor()
	host.published.set(LIVE_HOST_STARTED, { ...receipt, status: "started" })
	host.event(LIVE_HOST_STARTED)
	await nextTurn()
	context.mock.timers.tick(24 * 60 * 60 * 1000)
	assert.deepEqual(host.failures, [])
	host.published.set(LIVE_HOST_COMPLETION, receipt)
	host.event(LIVE_HOST_COMPLETION)
	await nextTurn()
	context.mock.timers.tick(LIVE_HOST_CLOSE_TIMEOUT_MS)
	assert.deepEqual(host.failures, ["host-close-timeout"])
	assert.equal(host.disposed(), 1)
})

test("observed close disposes the watchdog, and stale identity fails without waiting", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] })
	const good = monitor()
	good.published.set(LIVE_HOST_STARTED, { ...receipt, status: "started" })
	good.published.set(LIVE_HOST_COMPLETION, receipt)
	good.event(LIVE_HOST_COMPLETION)
	await nextTurn()
	good.session.dispose()
	context.mock.timers.tick(LIVE_HOST_STARTUP_TIMEOUT_MS)
	assert.deepEqual(good.failures, [])
	const stale = monitor()
	stale.published.set(LIVE_HOST_STARTED, { ...receipt, status: "started", nonce: randomUUID() })
	stale.event(LIVE_HOST_STARTED)
	await nextTurn()
	assert.deepEqual(stale.failures, ["host-completion-invalid"])
	assert.equal(stale.disposed(), 1)
})

test("a synchronous registration error cannot leak the returned watcher", () => {
	let closed = 0
	const failures: string[] = []
	const host = watchLiveHost("unused", expected, (error) => failures.push(error.code), {
		watchFiles: (_event, error) => {
			error()
			return {
				dispose: () => {
					closed++
				},
			}
		},
	})
	assert.deepEqual(failures, ["host-completion-invalid"])
	assert.equal(closed, 1)
	host.dispose()
	assert.equal(closed, 1)
})
