import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import {
	isProcessAlive,
	readProcessTreeObservation,
	startNonCooperativeHttpStream,
	terminateProcessTree,
	writeProcessTreeFixture,
	CancellationStreamAI,
} from "./cancellationFixture"

const waitFor = async (condition: () => boolean | Promise<boolean>, timeout = 5_000): Promise<void> => {
	const deadline = Date.now() + timeout
	while (!(await condition())) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for cancellation fixture")
		await new Promise((resolve) => setTimeout(resolve, 25))
	}
}

test("unknown PID probe failures cannot become process-death evidence", (context) => {
	const probe = context.mock.method(process, "kill", () => {
		throw Object.assign(new Error("denied"), { code: "EPERM" })
	})
	assert.throws(() => isProcessAlive(12345), /denied/)
	probe.mock.mockImplementation(() => {
		throw Object.assign(new Error("gone"), { code: "ESRCH" })
	})
	assert.equal(isProcessAlive(12345), false)
})

test("records a client transport close independently from fixture teardown", async () => {
	const fixture = await startNonCooperativeHttpStream()
	const controller = new AbortController()
	try {
		const response = await fetch(fixture.url, { signal: controller.signal })
		assert.ok(response.body)
		const reader = response.body.getReader()
		const first = await reader.read()
		assert.equal(first.done, false)
		assert.equal(fixture.observation.responseStarted, true)
		controller.abort()
		const second = await reader.read().catch(() => ({ done: true, value: undefined }))
		assert.equal(second.done, true)
		await waitFor(() => fixture.observation.clientClosed)
		assert.equal(fixture.observation.closeReason, "client")
	} finally {
		await fixture.close()
	}
})

test("provider fixture observes the task signal and aborts its held HTTP read", async () => {
	const fixture = await startNonCooperativeHttpStream()
	const model = new CancellationStreamAI(fixture.url, "node never.cjs")
	const controller = new AbortController()
	model.registerRole("stream-task", "stream")
	const iterator = model.createMessage("", [], { taskId: "stream-task", signal: controller.signal })
	try {
		const first = await iterator.next()
		assert.equal(first.value?.type, "text")
		assert.equal(model.observations.get("stream-task")?.signalProvided, true)
		assert.equal(model.observations.get("stream-task")?.fetchStartedWithSignal, true)
		controller.abort()
		await iterator.next()
		await waitFor(() => model.observations.get("stream-task")?.abortObserved === true)
		await waitFor(() => model.observations.get("stream-task")?.streamReadAborted === true)
		await waitFor(() => fixture.observation.clientClosed)
		assert.equal(fixture.observation.closeReason, "client")
	} finally {
		model.dispose()
		await fixture.close()
	}
})

test("process fixture has a real command and grandchild that can be terminated", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-cancel-fixture-"))
	const fixture = await writeProcessTreeFixture(root)
	let observation = await readProcessTreeObservation(fixture.statePath)
	const child = spawn(process.execPath, [fixture.commandPath], { cwd: root, stdio: "ignore", windowsHide: true })
	try {
		await waitFor(async () => {
			observation = await readProcessTreeObservation(fixture.statePath)
			return (
				typeof observation.commandPid === "number" &&
				typeof observation.descendantActualPid === "number" &&
				observation.descendantReadyAt !== undefined
			)
		})
		assert.equal(isProcessAlive(observation.commandPid), true)
		assert.equal(isProcessAlive(observation.descendantActualPid), true)
		assert.equal(observation.descendantActualPid, observation.descendantPid)
		assert.equal(observation.descendantParentPid, observation.commandPid)
	} finally {
		observation = await readProcessTreeObservation(fixture.statePath)
		await terminateProcessTree(observation)
		child.kill()
		await waitFor(
			() => !isProcessAlive(observation.commandPid) && !isProcessAlive(observation.descendantActualPid),
		).catch(() => undefined)
		await fs.rm(root, { recursive: true, force: true })
	}
	await waitFor(() => !isProcessAlive(observation.commandPid) && !isProcessAlive(observation.descendantActualPid))
})
